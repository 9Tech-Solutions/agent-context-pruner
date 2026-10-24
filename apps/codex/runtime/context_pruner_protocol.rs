// SPDX-License-Identifier: MIT
// Copyright (c) 2026 9Tech Solutions
//! Validates pruning edits without giving the child process authority to rewrite messages.

use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{Error, ErrorKind, Write};

struct Budget(usize);

impl Write for Budget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "snapshot budget exceeded",
            ));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Count encoded bytes without cloning strings or retaining serialized output.
pub fn fits_budget<T: serde::Serialize>(items: impl IntoIterator<Item = T>, limit: usize) -> bool {
    let mut budget = Budget(limit);
    items
        .into_iter()
        .all(|item| serde_json::to_writer(&mut budget, &item).is_ok())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    DropCall,
    DropResult,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub call_index: usize,
    pub result_index: usize,
    pub call_id: String,
    pub action: Action,
    pub text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrunerResponse {
    pub edits: Vec<Edit>,
    #[serde(rename = "model")]
    pub _model: String,
}

pub struct Pair {
    pub call_index: usize,
    pub result_index: usize,
    pub call_id: String,
    tool: String,
    input: Value,
    result_text: String,
}

pub struct Prepared {
    pub messages: Vec<Value>,
    pub pairs: Vec<Pair>,
}

fn call(item: &Value) -> Option<(String, String, Value)> {
    if ["encrypted_content", "encrypted_function_args"]
        .iter()
        .any(|key| item.get(key).is_some_and(|v| !v.is_null()))
        || item["status"].as_str().is_some_and(|s| s != "completed")
    {
        return None;
    }
    // shortcut: shell strings have no inferred file path, add parsing when shell filename pins are required.
    let input = match item["type"].as_str()? {
        "function_call" => serde_json::from_str::<Value>(item["arguments"].as_str()?).ok()?,
        "custom_tool_call" => json!({"input": item["input"].as_str()?}),
        _ => return None,
    };
    if !input.is_object() {
        return None;
    }
    Some((
        item["call_id"].as_str()?.into(),
        item["name"].as_str()?.into(),
        input,
    ))
}

fn paired_type(call: &Value, result: &Value) -> bool {
    matches!(
        (call["type"].as_str(), result["type"].as_str()),
        (Some("function_call"), Some("function_call_output"))
            | (Some("custom_tool_call"), Some("custom_tool_call_output"))
    )
}

fn text_output(output: &Value) -> Option<String> {
    if let Some(text) = output.as_str() {
        return Some(text.into());
    }
    let parts = output
        .as_array()?
        .iter()
        .map(|block| {
            if block.as_object()?.len() != 2 || block["type"] != "input_text" {
                return None;
            }
            block["text"].as_str()
        })
        .collect::<Option<Vec<_>>>()?;
    Some(parts.join("\n"))
}

fn pairs(items: &[Value], protected: &HashSet<usize>) -> Vec<Pair> {
    let mut occurrences: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(id) = item["call_id"].as_str() {
            occurrences.entry(id).or_default().push(index);
        }
    }
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let (id, tool, input) = call(item)?;
            let indices = occurrences.get(id.as_str())?;
            if indices.len() != 2 || indices[0] != index {
                return None;
            }
            let result_index = indices[1];
            if index == 0
                || result_index >= items.len().saturating_sub(6)
                || protected.contains(&index)
                || protected.contains(&result_index)
                || !paired_type(item, &items[result_index])
            {
                return None;
            }
            let result_text = text_output(&items[result_index]["output"])?;
            Some(Pair {
                call_index: index,
                result_index,
                call_id: id,
                tool,
                input,
                result_text,
            })
        })
        .collect()
}

fn message(item: &Value) -> Value {
    let role = if item["role"] == "user" {
        "user"
    } else {
        "assistant"
    };
    let text = if item["type"] == "message"
        && matches!(item["role"].as_str(), Some("user" | "assistant"))
    {
        item["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| {
                        matches!(block["type"].as_str(), Some("input_text" | "output_text"))
                            .then(|| block["text"].as_str())
                            .flatten()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    json!({"role":role,"text":text,"toolUses":[]})
}

pub fn prepare(items: &[Value], protected: &HashSet<usize>) -> Prepared {
    let pairs = pairs(items, protected);
    let mut messages: Vec<Value> = items.iter().map(message).collect();
    for pair in &pairs {
        messages[pair.call_index] = json!({"role":"assistant","text":"","toolUses":[{
            "tool_use_id":pair.call_id,"tool":pair.tool,"input":pair.input
        }]});
        messages[pair.result_index] = json!({"role":"user","text":"","toolUses":[],"toolResults":[{
            "tool_use_id":pair.call_id,"text":pair.result_text,"isError":false
        }]});
    }
    Prepared { messages, pairs }
}

fn expected_truncation(text: &str) -> Result<String, &'static str> {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    if utf16.len() <= 420 {
        return Ok(text.into());
    }
    // A surrogate split is rejected, so a malformed child string cannot enter history.
    let head = String::from_utf16(&utf16[..300]).map_err(|_| "split surrogate")?;
    Ok(format!(
        "{head}\n[agent-context-pruner truncated {} chars of this tool result; re-run the tool if needed]",
        utf16.len() - 300
    ))
}

fn removal_note(pair: &Pair, output: &str) -> Value {
    let input: String = pair.input.to_string().chars().take(160).collect();
    let text = format!(
        "[agent-context-pruner removed tool call {} {input} ({} chars of output); re-run it if needed]",
        pair.tool,
        output.encode_utf16().count()
    );
    json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]})
}

pub fn apply(
    items: &[Value],
    prepared: &Prepared,
    response: &PrunerResponse,
) -> Result<Vec<Option<Value>>, &'static str> {
    if response.edits.len() > prepared.pairs.len() {
        return Err("too many edits");
    }
    let mut output: Vec<Option<Value>> = items.iter().cloned().map(Some).collect();
    let mut changed = HashSet::new();
    for edit in &response.edits {
        let pair = prepared
            .pairs
            .iter()
            .find(|p| {
                p.call_index == edit.call_index
                    && p.result_index == edit.result_index
                    && p.call_id == edit.call_id
            })
            .ok_or("unpaired or protected edit")?;
        if !changed.insert(pair.call_index) {
            return Err("duplicate edit");
        }
        let text = text_output(&items[pair.result_index]["output"]).ok_or("non-text output")?;
        match edit.action {
            Action::DropCall => {
                output[pair.call_index] = None;
                output[pair.result_index] = Some(removal_note(pair, &text));
            }
            Action::DropResult => {
                let expected = expected_truncation(&text)?;
                if edit.text.as_deref() != Some(expected.as_str()) {
                    return Err("invalid truncation");
                }
                let mut item = items[pair.result_index].clone();
                if expected != text {
                    item["output"] = if item["output"].is_array() {
                        json!([{"type":"input_text","text":expected}])
                    } else {
                        Value::String(expected)
                    };
                }
                output[pair.result_index] = Some(item);
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
