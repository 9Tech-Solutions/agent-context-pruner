// SPDX-License-Identifier: MIT
// Copyright (c) 2026 9Tech Solutions
use pruner_codex_runtime_protocol as protocol;
use std::process::Command;
use std::time::Duration;

#[path = "context_pruner_process.rs"]
mod subprocess;

fn node(script: &str) -> Vec<String> {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is required for the pruning helper tests");
    assert!(output.status.success());
    vec![
        String::from_utf8(output.stdout).unwrap().trim().into(),
        "-e".into(),
        script.into(),
    ]
}

#[tokio::test]
async fn closes_stdin_before_waiting_for_an_eof_driven_helper() {
    let args = node("process.stdin.pipe(process.stdout)");
    let model = "m".repeat(128 * 1024);
    let input = serde_json::to_vec(&serde_json::json!({"model":model,"edits":[]})).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(3), subprocess::request(&args, input))
        .await
        .expect("The bridge kept stdin open while the helper waited for EOF")
        .expect("The helper response should be accepted");
    assert_eq!(response._model, model);
    assert!(response.edits.is_empty());
}

#[tokio::test]
async fn rejects_failed_helpers_and_invalid_json() {
    for script in ["process.exit(7)", "process.stdout.write('invalid json')"] {
        assert!(
            subprocess::request(&node(script), Vec::new())
                .await
                .is_none()
        );
    }
}

#[tokio::test]
async fn rejects_oversized_output() {
    let args = node("process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))");
    assert!(subprocess::request(&args, Vec::new()).await.is_none());
}
