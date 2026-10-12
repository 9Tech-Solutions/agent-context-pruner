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

`packages/domain` → `packages/models` → `apps/*`. Never import in the other direction.

- `packages/domain` (`@9tech.solutions/pruner-domain`): the host-neutral core. Transcript
  types, tool-call pairing, state fitting, keep/drop decisions, and the `DecisionModel` port.
  Zero runtime dependencies, enforced by `tests/architecture.test.ts`.
- `packages/models` (`@9tech.solutions/pruner-models`): `DecisionModel` adapters. One
  SystemOne adapter with provider profiles (`typesafe`, `cloudflare`, `ollama`, `custom`) and a
  rules-based `heuristic` model.
- `apps/` (planned): the Claude Code plugin, a CLI, and later Codex and Antigravity hosts.

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

- The project is under PolyForm Shield 1.0.0 (`LICENSE`): free to use, fork and contribute, but
  not to provide a competing product. Call it "source-available", not "open source".
- Logic ported from fast-jev-compaction (MIT) keeps its notice in `NOTICE`. Keep that file when
  moving or renaming ported code.
