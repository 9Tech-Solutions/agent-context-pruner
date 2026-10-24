# Contributing

Issues and pull requests are welcome. By submitting a contribution you agree that it is licensed
under the project's license, [MIT](LICENSE).

## Set up

```sh
bun install
bun run ready        # format, lint, type check, test, build: what CI runs
```

The local model server is Python, managed with uv:

```sh
cd servers/systemone-server
uv run pytest
```

[AGENTS.md](AGENTS.md) holds the architecture and code rules. The short version: the domain
package has no dependencies, everything returns `Result` instead of throwing, adapters reach the
network only through the injected `HttpTransport`, and new behaviour comes with a test.

## Adding a decision model

1. **It speaks `/v1/systemone`** (a POST of `state` plus `noul` questions, answered with
   `{"answers": {name: {"noul": p}}}`): add a profile in
   `packages/models/src/systemone/profiles.ts` with its endpoint and limits (request tokens,
   questions per request), then a request test in `packages/models/tests/systemone.test.ts`.
   A hosted profile must ignore `baseUrl`, so its key never reaches another server. To give it
   its own provider name, add it to `PROVIDERS` in `packages/models/src/providers.ts` and to the
   `provider` options in `apps/claude-code-plugin/plugin/.claude-plugin/plugin.json`.
2. **It does not:** implement the `DecisionModel` port
   (`packages/domain/src/ports/decision-model.ts`) in a new folder under `packages/models/src/`.
   Never change the domain to fit a model.
3. **Measure it** before opening the pull request, and put the numbers in it:

   ```sh
   bun apps/cli/src/main.ts eval <session.jsonl>... --provider heuristic,<yours>
   ```

   Use sessions you are allowed to send to that provider.

## Changing the Claude Code plugin

- `bun run ready` rebuilds the bundled hook (`apps/claude-code-plugin/plugin/hooks/pruner.js`).
  Commit it with the source: CI fails when they differ.
- Bump `version` in `plugin.json` for every change users should get. `claude plugin update`
  compares that field only.
- Check the bundle against Claude Code's real hook API with
  `claude plugin validate apps/claude-code-plugin/plugin`, and try it in a separate session:
  `claude --plugin-dir apps/claude-code-plugin/plugin`.

## Releasing the npm packages

`domain`, `models`, `eval` and `cli` publish from staged folders, because the workspace
manifests point `exports` at `src` for development:

```sh
bun run ready && bun run stage-publish
cd .publish/pruner-domain && npm publish   # then models, eval, cli, in that order
```

Bump the versions in the workspace `package.json` files first. Run npm from inside the staged
folder: from the repository root it refuses, because the root manifest asks for Bun.

## Commits

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.
