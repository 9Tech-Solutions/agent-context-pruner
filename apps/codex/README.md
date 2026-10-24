# Codex adapters

## Official Codex through a local proxy

The stock adapter keeps the official Codex executable unchanged. Its launcher starts an
authenticated loopback proxy, routes model requests through it, and closes it when Codex exits.
The proxy uses the existing offline heuristic to shorten old successful text tool results.
It preserves call/output pairs, the first and newest six items, failures, messages, media,
encrypted items, and ambiguous histories. Invalid plans and unsupported inputs pass through.
There are no provider calls for pruning and no credential or transcript logs.

From the repository root, run `bun install` and `bun run ready`. On Windows, capture the
repository and official npm launcher paths once, then use them from any working directory:

```powershell
$prunerRoot = (Get-Location).Path
$codexPrefix = Split-Path -Parent (Get-Command codex.cmd -CommandType Application).Path
$officialCodex = Join-Path $codexPrefix 'node_modules/@openai/codex/bin/codex.js'
node (Join-Path $prunerRoot 'apps/codex/dist/stock-launch.mjs') $officialCodex
```

To make the ordinary PowerShell `codex` command use the adapter, run:

```powershell
& (Join-Path $prunerRoot 'apps/codex/install-powershell.ps1')
```

The installer copies the built JavaScript into `%LOCALAPPDATA%/codex-context-pruner` and adds
a marked function to the PowerShell 7 and Windows PowerShell profiles. It backs up existing
profiles before changing them, preflights syntax for all profiles, writes UTF-8 with a BOM for
Windows PowerShell compatibility, and rolls back profile writes if installation fails. It is
safe to repeat. New shells resolve the
official npm launcher on each invocation, so npm updates keep using the current official binary.
Existing Codex sessions keep their current runtime. Direct application or IDE launches that
bypass these PowerShell profiles keep their existing behavior.
Legacy ANSI profiles must be converted to UTF-8 with a BOM before installation; unreadable
profiles stop the preflight before any profile is changed.

Maintenance commands, remote clients, named profiles, custom provider/base-URL settings,
explicit routing or shell-policy overrides, and projects with their own shell policies use
the official launcher directly. For a one-session bypass, set `$env:CODEX_PRUNER_BYPASS = '1'`.
Calling the canonical `codex.cmd` also bypasses the profile function. Remove the marked profile
block, or restore the installer's backup, to undo the integration.

This launcher targets an unmanaged local configuration. Detected configuration or requirements
files in the standard system paths bypass it; Windows detection uses the `ProgramData`
environment path. System- and cloud-managed deployments are outside this adapter's supported
scope; use the canonical `codex.cmd` for those sessions.

The default upstream is the ChatGPT Codex backend for ChatGPT sign-in, or the OpenAI API for
API-key authentication. `CODEX_PRUNER_UPSTREAM` can select an HTTPS upstream or a loopback HTTP
test server. The launcher uses a fresh local token, excludes it from tool subprocesses, and
forces HTTP streaming, uncompressed requests, and a private runtime so a shared daemon cannot
bypass the proxy. Upstream redirects are rejected. The TOML parser is bundled with its
BSD-3-Clause notice in `THIRD_PARTY_NOTICES.txt`; no runtime npm install is needed.

The proxy edits outgoing requests only. Saved transcripts retain the originals; resuming
reapplies pruning to full requests. Requests referencing `previous_response_id` and native
compaction requests pass through unchanged. Native compaction remains enabled. Bodies above
32 MiB are rejected. This adapter does not replace Codex's internal history or its summarizer.

The synthetic native smoke uses the official executable, isolated homes, fake credentials,
and loopback Responses traffic:

```powershell
node (Join-Path $prunerRoot 'apps/codex/dist/stock-smoke.mjs') $officialCodex
```

On 2026-10-24, the installed stock adapter passed the native smoke on Windows with both the
official Codex 0.164.0 executable and its npm JavaScript launcher. The three scenarios cover
a real local file read and shell-token isolation, old-result pruning and restart/resume, and
native manual and automatic compaction. The full workspace check passed 164 TypeScript tests,
including 48 in this package. Unchanged suites reused the build system's verified cache.
No live workload, quality, latency, caching, or cost benchmark was run.

## Custom Codex CLI adapter (experimental)

This adapter connects the existing pruning core to a custom Codex CLI 0.163.0 build.
It is separate from the Claude Code plugin. Stock Codex command hooks cannot replace active
history, and installing this package does not change a running Codex session.

The runtime patch is pinned to upstream commit
`83086188ae0614bd882818ff1aa23f3194962012` (`rust-v0.163.0`).

## Build

Requires the repository's Bun/Node environment and a working Rust 1.95.0 native build
toolchain for Codex. On Windows, use the corresponding C/C++ compiler and SDK, or a configured
GNU toolchain. The official Codex installation can remain available alongside this build.

From the pruner repository:

```sh
bun install
bun run ready
git clone --depth 1 --branch rust-v0.163.0 https://github.com/openai/codex.git /absolute/path/to/codex-pruner
node apps/codex/dist/prepare.mjs /absolute/path/to/codex-pruner
```

The prepare command checks the exact upstream commit, applies the patch, and copies four Rust
files with their MIT license and attribution notices. It rejects conflicting runtime files and
can be repeated on the same prepared checkout. The release tag's Cargo lockfile needs its
workspace versions updated from `0.0.0` to `0.163.0` on the first build; normal Cargo resolution
performs this update.

Build the executable in that Codex checkout:

```sh
cd /absolute/path/to/codex-pruner/codex-rs
cargo build -p codex-cli -p codex-code-mode-host --bins
```

On Windows, build the CLI and upstream sandbox helpers together in the same output directory:

```sh
cargo build -p codex-cli -p codex-code-mode-host -p codex-windows-sandbox --bins
```

`codex-code-mode-host` must be beside the CLI executable. Codex uses it to run `exec`,
including local commands, file reads, and tool discovery. A successful `codex --version`
does not check that this component is present.

For a separate CLI build, the unmodified host from the official platform distribution for the
same version can also be placed beside it. The verified Windows GNU prototype uses the
official 0.163.0 Windows host with the patched 0.163.0 CLI. Keep the upstream license and
notices with these binaries; do not mix release versions.

## Run

Use absolute paths; the Windows executable ends in `codex.exe`.

```sh
node /absolute/path/to/agent-context-pruner/apps/codex/dist/launch.mjs /absolute/path/to/codex-pruner/codex-rs/target/debug/codex
```

The launcher sets `CODEX_CONTEXT_PRUNER_COMMAND` for its child process and disables the shared
daemon so it cannot attach to an already running stock runtime. Codex's model and
authentication code are retained. Launching the official executable normally uses its usual
compaction behavior.

The default decision model is `heuristic`, which works offline. To select another existing
provider, set `PRUNER_PROVIDER` to `typesafe`, `cloudflare`, `ollama`, or `custom`, using the
credential environment variables documented in the root README. `PRUNER_MODEL` and
`PRUNER_BASE_URL` configure local providers. A provider failure retries the rules model.
Network decision providers receive the projected conversation text; the default sends none.

## Runtime behavior

- Both manual and automatic compaction try pruning before the native summarizer. Existing
  pre/post-compaction hooks still run. Speculative remote summaries are disabled while the
  opt-in bridge is enabled.
- Only unambiguous, completed function/custom-tool calls paired with text results are
  candidates. Results can be strings or arrays containing only `input_text` blocks with no
  other fields. The first and newest six history items, explicit failures, encrypted items,
  mixed media, unknown content blocks, and host-protected evidence are retained.
- User/assistant text, instructions, unknown item types, item order, and unchanged metadata
  stay intact. Removed calls leave a bounded note. Truncated results must match the domain's
  exact text; the child cannot invent a replacement message.
  Untouched content arrays retain their original JSON values. Truncating an array
  keeps its array representation and replaces its text with the validated truncation.
- The child has a 15-second timeout, a 32 MiB input/snapshot budget, and a 4 MiB output budget.
  Invalid or duplicate edits, an insufficient reduction (less than 25%), a stale snapshot,
  or a remaining over-limit history use built-in compaction.
- Installation checks history generation, length, and original contents while holding the
  session state lock.
  It persists the replacement checkpoint through Codex's existing save/resume path. Existing
  opaque checkpoints keep their producer metadata.

## Verification

Filename pinning currently covers structured path arguments. Arbitrary shell command strings
require host-specific path extraction, which this prototype leaves unchanged.

```sh
bun run --cwd apps/codex test
cargo test --locked --manifest-path apps/codex/runtime/Cargo.toml
node apps/codex/dist/smoke.mjs /absolute/path/to/patched/codex
```

The runtime smoke command uses isolated temporary Codex homes, synthetic transcripts, and a
loopback model endpoint. It first executes a real `exec` call, checks tool discovery, and runs
a local command that reads a large temporary fixture. It ages that real result, compacts it,
and checks that the next model request excludes the old output without a summarizer request.
That case uses unrestricted access in its
temporary session and reads only the fixture; it does not provision the Windows sandbox.
The host is required, with in-process execution fallback disabled in the test configuration.
It then asserts manual/automatic pruning, continuation, restart/resume,
and native fallback for both local and remote-V2 compaction routes. Automatic cases first
sample the synthetic history to establish token usage, then test the next turn's trigger.
Successful scenarios use the public launcher; forced failures inject a failing helper directly.
It makes no OpenAI model
requests and writes a JSON report only after every scenario passes. It does not measure model
quality or speed on real workloads.

The compaction fixtures include both legacy string results and code-mode text arrays. Mixed
media and unknown content blocks are covered by the Rust boundary tests.

The adapter, protocol, and helper-process tests run in CI. The Rust helper tests use Node to
check the actual EOF handshake and reject failed, malformed, and oversized responses.
The full upstream binary build and runtime smoke suite are separate checks. Check the smoke
report before treating a custom build as ready.

On 2026-10-17, the pinned custom CLI and matching official code-mode host passed all seven
runtime scenarios on Windows. This includes pruning output generated by a real local tool
without a summarizer request, plus restart/resume with mixed legacy and code-mode output
formats in all six compaction scenarios. The Rust boundary suite has twelve passing tests. Live OpenAI
model requests, sandbox provisioning, and other platforms remain untested.

MIT licensed. Upstream Codex code in the patch remains under Apache-2.0; its license and
notices are retained in [`third_party/codex`](../../third_party/codex).
