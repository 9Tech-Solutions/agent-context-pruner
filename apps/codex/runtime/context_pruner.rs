// SPDX-License-Identifier: MIT
// Copyright (c) 2026 9Tech Solutions
//! Opt-in subprocess bridge for agent-context-pruner. Errors preserve built-in compaction.

#[path = "context_pruner_protocol.rs"]
mod protocol;
#[path = "context_pruner_process.rs"]
mod subprocess;

use crate::context::world_state::WorldStateSnapshot;
use crate::context_manager::estimate_item_token_count;
use crate::session::CompactedHistoryInstallation;
use crate::session::session::Session;
use crate::session::step_context::StepContext;
use codex_history::ResponseItemEnvelope;
use codex_protocol::items::{ContextCompactionItem, TurnItem};
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::{EventMsg, WarningEvent};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

const COMMAND: &str = "CODEX_CONTEXT_PRUNER_COMMAND";
const MAX_INPUT: usize = 32 * 1024 * 1024;

pub(crate) fn enabled() -> bool {
    std::env::var_os(COMMAND).is_some()
}

fn argv() -> Option<Vec<String>> {
    let args: Vec<String> = serde_json::from_str(&std::env::var(COMMAND).ok()?).ok()?;
    (args.first().is_some_and(|arg| Path::new(arg).is_absolute()) && args.len() <= 16)
        .then_some(args)
}

fn protected(items: &[ResponseItemEnvelope]) -> HashSet<usize> {
    items
        .iter()
        .enumerate()
        .filter_map(|(i, envelope)| {
            let metadata_protected = envelope.metadata.as_ref().is_some_and(|m| {
                m.client_authored || m.retained_source.is_some() || !m.guardian_sources.is_empty()
            });
            let failed = match &envelope.item {
                ResponseItem::FunctionCallOutput { output, .. }
                | ResponseItem::CustomToolCallOutput { output, .. } => {
                    output.success == Some(false)
                }
                _ => false,
            };
            (metadata_protected || failed).then_some(i)
        })
        .collect()
}

fn rebuild(
    items: &[ResponseItemEnvelope],
    values: &[Value],
    changed: Vec<Option<Value>>,
) -> Option<Vec<ResponseItemEnvelope>> {
    let mut output = Vec::new();
    for (i, value) in changed.into_iter().enumerate() {
        let Some(value) = value else { continue };
        if value == values[i] {
            output.push(items[i].clone());
            continue;
        }
        let mut item: ResponseItem = serde_json::from_value(value).ok()?;
        match (&items[i].item, &mut item) {
            (
                ResponseItem::FunctionCallOutput {
                    output: original, ..
                },
                ResponseItem::FunctionCallOutput {
                    output: changed, ..
                },
            )
            | (
                ResponseItem::CustomToolCallOutput {
                    output: original, ..
                },
                ResponseItem::CustomToolCallOutput {
                    output: changed, ..
                },
            ) => {
                changed.success = original.success;
            }
            _ => {}
        }
        let metadata = if item.item_type() == items[i].item.item_type() {
            items[i].metadata.clone()
        } else {
            None
        };
        item.set_id(None);
        output.push(ResponseItemEnvelope { item, metadata });
    }
    Some(output)
}

fn tokens(items: &[ResponseItemEnvelope]) -> i64 {
    items
        .iter()
        .map(|e| estimate_item_token_count(&e.item))
        .sum()
}

async fn prune(
    items: &[ResponseItemEnvelope],
    args: &[String],
    instructions: Option<&str>,
) -> Option<Vec<ResponseItemEnvelope>> {
    if items.len() > 20_000 || !protocol::fits_budget(items.iter().map(|e| &e.item), MAX_INPUT) {
        return None;
    }
    let values = items
        .iter()
        .map(|e| serde_json::to_value(&e.item))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let prepared = protocol::prepare(&values, &protected(items));
    if prepared.pairs.is_empty() {
        return None;
    }
    let payload = serde_json::to_vec(
        &json!({"messages":prepared.messages,"instructions":instructions.unwrap_or_default()}),
    )
    .ok()?;
    let response = subprocess::request(args, payload).await?;
    let changed = protocol::apply(&values, &prepared, &response).ok()?;
    rebuild(items, &values, changed)
}

pub(crate) async fn try_compact(
    sess: &Session,
    step: &StepContext,
    started: Option<&TurnItem>,
    instructions: Option<&str>,
) -> bool {
    if !enabled() {
        return false;
    }
    let started_at = Instant::now();
    let Some(args) = argv() else {
        return false;
    };
    let snapshot = sess.clone_history().await;
    let Some(baseline) = snapshot.world_state_checkpoint() else {
        return false;
    };
    let items = snapshot.annotated_items();
    let Some(output) = prune(items, &args, instructions).await else {
        return false;
    };
    let (before, after) = (tokens(items), tokens(&output));
    let limit = step
        .turn
        .config
        .model_auto_compact_token_limit
        .or_else(|| step.settings.model_info.auto_compact_token_limit());
    if before <= 0 || after * 4 > before * 3 || limit.is_some_and(|limit| after >= limit) {
        return false;
    }
    install(
        sess,
        step,
        started,
        &snapshot,
        output,
        WorldStateSnapshot::from(&baseline.state),
        (before, after),
        started_at,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn install(
    sess: &Session,
    step: &StepContext,
    started: Option<&TurnItem>,
    snapshot: &crate::context_manager::ContextManager,
    output: Vec<ResponseItemEnvelope>,
    baseline: WorldStateSnapshot,
    (before, after): (i64, i64),
    started_at: Instant,
) -> bool {
    let item = started
        .cloned()
        .unwrap_or_else(|| TurnItem::ContextCompaction(ContextCompactionItem::new()));
    let installed = sess
        .replace_compacted_history(
            output,
            step.to_turn_context_item(),
            baseline,
            CompactedHistoryInstallation::Pruned {
                generation: snapshot.history_version(),
                len: snapshot.annotated_items().len(),
                expected: snapshot.annotated_items(),
                input_goal_ids: crate::context::UserGoalUpdate::message_ids(snapshot.raw_items()),
            },
        )
        .await;
    if !installed {
        return false;
    }
    if started.is_none() {
        sess.emit_turn_item_started(&step.turn, &item).await;
    }
    sess.recompute_token_usage(&step.turn).await;
    sess.emit_turn_item_completed(&step.turn, item).await;
    sess.send_event(&step.turn, EventMsg::Warning(WarningEvent {
        message: format!("agent-context-pruner: pruned history without a summary ({before} to {after} estimated tokens, {} ms)", started_at.elapsed().as_millis()),
    })).await;
    true
}
