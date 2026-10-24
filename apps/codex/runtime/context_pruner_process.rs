// SPDX-License-Identifier: MIT
// Copyright (c) 2026 9Tech Solutions
//! Runs the bounded pruning helper without a shell.

use super::protocol;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const MAX_INPUT: usize = 32 * 1024 * 1024;
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

pub(super) async fn request(args: &[String], payload: Vec<u8>) -> Option<protocol::PrunerResponse> {
    if payload.len() > MAX_INPUT {
        return None;
    }
    let mut command = Command::new(args.first()?);
    command
        .args(&args[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // Keep the helper's console hidden.
    let mut child = command.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut stdout = child.stdout.take()?.take(MAX_OUTPUT + 1);
    let mut output = Vec::new();
    let run = async {
        let write = async move {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await // Dropping the owned stdin sends EOF before waiting for exit.
        };
        let (_, _, status) =
            tokio::try_join!(write, stdout.read_to_end(&mut output), child.wait())?;
        Ok::<_, std::io::Error>(status)
    };
    let status = match tokio::time::timeout(Duration::from_secs(15), run).await {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            return None;
        }
    };
    if !status.success() || output.len() > MAX_OUTPUT as usize {
        return None;
    }
    serde_json::from_slice(&output).ok()
}
