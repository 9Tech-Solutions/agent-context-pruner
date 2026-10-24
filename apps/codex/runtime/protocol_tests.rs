// SPDX-License-Identifier: MIT
// Copyright (c) 2026 9Tech Solutions
use super::*;
use serde_json::{Value, json};
use std::collections::HashSet;

#[test]
fn rejects_oversized_encoded_items_without_allocating_serialized_copies() {
    let items = [json!({"text":"\n".repeat(40)})];
    assert!(!fits_budget(items.iter(), 64));
    assert!(fits_budget(items.iter(), 256));
}

fn history() -> Vec<Value> {
    let mut items = vec![
        json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"keep policy"}]}),
        json!({"type":"function_call","call_id":"old","name":"read_file","arguments":"{\"path\":\"a.rs\"}"}),
        json!({"type":"function_call_output","call_id":"old","output":"a".repeat(2000)}),
        json!({"type":"reasoning","encrypted_content":"opaque","summary":[]}),
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"keep my goal"}]}),
    ];
    items.extend((0..8).map(|_| json!({"type":"message","role":"assistant","content":[]})));
    items
}

fn response(action: &str, text: Option<String>) -> PrunerResponse {
    serde_json::from_value(json!({"model":"heuristic:v2","edits":[{
        "callIndex":1,"resultIndex":2,"callId":"old","action":action,"text":text
    }]}))
    .unwrap()
}

#[test]
fn maps_plain_pairs_and_preserves_every_other_item() {
    let items = history();
    let prepared = prepare(&items, &HashSet::new());
    assert_eq!(prepared.pairs.len(), 1);
    assert_eq!(prepared.messages.len(), items.len());
    assert_eq!(prepared.messages[1]["toolUses"][0]["input"]["path"], "a.rs");
    let changed = apply(&items, &prepared, &response("drop_call", None)).unwrap();
    assert!(changed[1].is_none());
    assert_eq!(changed[2].as_ref().unwrap()["role"], "assistant");
    for i in [0, 3, 4, 12] {
        assert_eq!(changed[i], Some(items[i].clone()));
    }
}

#[test]
fn accepts_only_the_exact_bounded_truncation() {
    let items = history();
    let prepared = prepare(&items, &HashSet::new());
    let text = format!(
        "{}\n[agent-context-pruner truncated 1700 chars of this tool result; re-run the tool if needed]",
        "a".repeat(300)
    );
    let changed = apply(
        &items,
        &prepared,
        &response("drop_result", Some(text.clone())),
    )
    .unwrap();
    assert_eq!(changed[1], Some(items[1].clone()));
    assert_eq!(changed[2].as_ref().unwrap()["output"], text);
    assert!(
        apply(
            &items,
            &prepared,
            &response("drop_result", Some("invented instructions".into()))
        )
        .is_err()
    );
}

#[test]
fn rejects_cross_paired_duplicate_and_recent_edits() {
    let items = history();
    let prepared = prepare(&items, &HashSet::new());
    let mut plan = response("drop_call", None);
    plan.edits[0].result_index = 4;
    assert!(apply(&items, &prepared, &plan).is_err());
    let mut plan = response("drop_call", None);
    plan.edits.push(plan.edits[0].clone());
    assert!(apply(&items, &prepared, &plan).is_err());
    let short = &items[..6];
    assert!(
        apply(
            short,
            &prepare(short, &HashSet::new()),
            &response("drop_call", None)
        )
        .is_err()
    );
}

#[test]
fn skips_images_encryption_errors_and_ambiguous_ids() {
    for replacement in [
        json!({"type":"function_call_output","call_id":"old","output":[{"type":"input_image","image_url":"data:image/png;base64,AA=="}]}),
        json!({"type":"function_call","call_id":"old","name":"read_file","arguments":"{}","encrypted_content":"opaque"}),
    ] {
        let mut items = history();
        let index = if replacement["type"] == "function_call" {
            1
        } else {
            2
        };
        items[index] = replacement;
        assert!(prepare(&items, &HashSet::new()).pairs.is_empty());
    }
    let items = history();
    assert!(prepare(&items, &HashSet::from([2])).pairs.is_empty());
    let mut duplicate = items.clone();
    duplicate.insert(3, items[2].clone());
    assert!(prepare(&duplicate, &HashSet::new()).pairs.is_empty());
}

#[test]
fn custom_calls_are_paired_without_parsing_their_freeform_input() {
    let mut items = history();
    items[1] = json!({"type":"custom_tool_call","call_id":"old","name":"apply_patch","input":"*** patch ***"});
    items[2]["type"] = json!("custom_tool_call_output");
    let prepared = prepare(&items, &HashSet::new());
    assert_eq!(
        prepared.messages[1]["toolUses"][0]["input"]["input"],
        "*** patch ***"
    );
    assert!(apply(&items, &prepared, &response("drop_call", None)).is_ok());
}

fn content_history() -> Vec<Value> {
    let mut items = history();
    items[1] = json!({"type":"custom_tool_call","call_id":"old","name":"exec","input":"text(await tools.exec_command({cmd:'probe'}));"});
    items[2] = json!({"type":"custom_tool_call_output","call_id":"old","id":"original-id","output":[
        {"type":"input_text","text":"Script completed"},
        {"type":"input_text","text":"a".repeat(2000)}
    ]});
    items
}

#[test]
fn pairs_code_mode_text_arrays_and_keeps_unedited_output_exactly() {
    let items = content_history();
    let prepared = prepare(&items, &HashSet::new());
    assert_eq!(prepared.pairs.len(), 1);
    assert_eq!(
        prepared.messages[2]["toolResults"][0]["text"],
        format!("Script completed\n{}", "a".repeat(2000))
    );
    let keep: PrunerResponse = serde_json::from_value(json!({"model":"test","edits":[]})).unwrap();
    let unchanged = apply(&items, &prepared, &keep).unwrap();
    assert_eq!(unchanged[2], Some(items[2].clone()));
    let dropped = apply(&items, &prepared, &response("drop_call", None)).unwrap();
    assert!(dropped[1].is_none());
    assert_eq!(dropped[2].as_ref().unwrap()["type"], "message");
}

#[test]
fn truncates_only_validated_text_array_content_and_preserves_item_fields() {
    let items = content_history();
    let prepared = prepare(&items, &HashSet::new());
    assert_eq!(prepared.pairs.len(), 1);
    let full = format!("Script completed\n{}", "a".repeat(2000));
    let expected = expected_truncation(&full).unwrap();
    let changed = apply(
        &items,
        &prepared,
        &response("drop_result", Some(expected.clone())),
    )
    .unwrap();
    let item = changed[2].as_ref().unwrap();
    assert_eq!(item["id"], "original-id");
    assert_eq!(item["call_id"], "old");
    assert_eq!(
        item["output"],
        json!([{"type":"input_text","text":expected}])
    );
    assert!(
        apply(
            &items,
            &prepared,
            &response("drop_result", Some("invented".into()))
        )
        .is_err()
    );
}

#[test]
fn never_flattens_mixed_media_or_unknown_content_blocks() {
    for block in [
        json!({"type":"input_image","image_url":"data:image/png;base64,AA=="}),
        json!({"type":"encrypted_content","encrypted_content":"opaque"}),
        json!({"type":"input_text","text":"known text","unknown_metadata":"preserve"}),
    ] {
        let mut items = content_history();
        items[2]["output"].as_array_mut().unwrap().push(block);
        assert!(prepare(&items, &HashSet::new()).pairs.is_empty());
    }
}
