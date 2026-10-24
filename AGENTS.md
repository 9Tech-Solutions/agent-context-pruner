# agent-context-pruner: rules for coding agents

## Commands

`vp` is the local Vite+ CLI. `bun run` puts it on PATH; in a shell, use `bunx vp` or add
`node_modules/.bin` to PATH.

| Task                     | Command                        |
| ------------------------ | ------------------------------ |
| Install                  | `bun install`                  |
| Format, lint, type check | `vp check` (`--fix` to format) |
| All tests                | `vp run -r test`               |
| One package's tests      | `vp test` inside the package   |
| Build the libraries      | `vp run -r build`              |
| Everything, as CI would  | `bun run ready`                |

## Layout and dependency direction

`packages/domain` → `packages/models`, `packages/eval` → `apps/*`. Never import in the other
direction. `packages/eval` depends on the domain only.

- `packages/domain` (`@9tech.solutions/pruner-domain`): the host-neutral core. Transcript
  types, tool-call pairing, state fitting, keep/drop decisions, and the `DecisionModel` port.
  Zero runtime dependencies, enforced by `tests/architecture.test.ts`.
- `packages/models` (`@9tech.solutions/pruner-models`): `DecisionModel` adapters. One
  SystemOne adapter with provider profiles (`typesafe`, `cloudflare`, `ollama`, `custom`) and a
  rules-based `heuristic` model.
- `packages/eval` (`@9tech.solutions/pruner-eval`): the evaluation harness. Picks compaction
  points in a transcript, labels each call by what the session did after the point (hindsight),
  replays every keep threshold, and reports reduction, lost results, net saving and AUC. Pure:
  it takes a `DecisionModel` and `Message[]`, never files or network.
- `apps/claude-code-plugin` (`@9tech.solutions/pruner-claude-code`): the Claude Code host
  adapter. `src/` is the hook logic; `plugin/` is the installable plugin folder that
  `.claude-plugin/marketplace.json` at the repo root points to.
- `apps/cli` (`@9tech.solutions/pruner-cli`): `agent-context-pruner eval`. Reads Claude Code
  `.jsonl` sessions (`src/transcript.ts`, split at each `compact_boundary`), builds models from
  environment keys, and prints the eval report. Run from source with `bun apps/cli/src/main.ts`.
- `servers/systemone-server` (Python, uv, outside the Bun workspace): a `/v1/systemone` server
  around any model with `system_one(state, questions)`, such as LiquidAI d1-3B. Standard library
  only; torch and transformers come from the `hf` extra. `uv run pytest` inside it.
- `apps/` (planned): Codex and Antigravity hosts.

## The Claude Code plugin

- Bump `version` in `plugin/.claude-plugin/plugin.json` (and the package's `package.json`) in
  every commit that changes what users get. `claude plugin update` compares that field only:
  a new commit at the same version answers "already at the latest version" and installs nothing.
- A hooks module may import only files inside its plugin folder, so `vp pack` bundles
  `src/register.ts` and both packages into `plugin/hooks/pruner.js`. That file is generated
  and committed: rebuild it (`bun run ready` does) and commit it with any change under
  `packages/` or `apps/claude-code-plugin/src/`. Formatting and lint skip it.
- `src/claude-code.d.ts` declares only the slice of the hook API the plugin uses, written from
  the types Claude Code 2.1.296 generates. `claude plugin validate apps/claude-code-plugin/plugin`
  checks the bundle against the real API; run it after touching the hook.
- Never load this plugin into the session that is editing it: its `turn.complete` hook can
  compact that session's own context. Test it in a separate session with
  `claude --plugin-dir apps/claude-code-plugin/plugin`.

## Architecture rules

- The domain and adapters return `Result<T, E>` and never throw. `compact()` also catches an
  adapter that throws and turns it into a `model_failed` error.
- Adapters reach the network only through the injected `HttpTransport`. No vendor SDKs: the
  Claude Code hook runtime has no Node and offers only `$.http.fetch`.
- A new model is a new `DecisionModel` (or a new SystemOne profile), never a change to the domain.
- Model-specific limits (context window, questions per request, keep threshold) live in the
  adapter or profile, not in the domain.

## Code rules

- TypeScript strict, no `any`, no unused locals or parameters.
- Functions under 50 lines, files under 800 lines, nesting under 4 levels.
- Immutable updates: return new objects. Local accumulators inside a function are fine.
- No `console` in library code.
- Tests use `vite-plus/test`. New behavior gets a test first.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.

## Licensing

- The source uses the MIT license (`LICENSE`). Before public claims or submissions, verify the published target branch, not only the worktree. Trigger: promotion after a local license change; root cause: a worktree-level MIT instruction was mistaken for the public license. Verified 2026-10-19: local LICENSE was MIT while origin/main remained PolyForm Shield, so the promo draft used EVALUATION DEMO. Keep the copyright, license,
  and third-party attribution notices when distributing it.
- Logic ported from fast-jev-compaction (MIT) keeps its notice in `NOTICE`. Keep that file when
  moving or renaming ported code.
- Trigger: delegated playground copy used an MIT footer and described modeled re-reads as observed agent actions. Root cause: template copy followed local license metadata and inferred token savings from a reduction field. Verify origin/main for public license claims and trace metric definitions before writing explanations. Verified 2026-10-19: sweep.ts measures characters and charges modeled full re-reads; the UI/export copy now names those units and omits unverified MIT claims.
