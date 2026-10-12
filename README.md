# agent-context-pruner

Context compaction for AI coding agents that never summarizes. When the context fills up, a fast
decision model scores every old tool call and tool result, and only the ones no longer needed
are dropped or truncated. Everything kept stays word for word: user and assistant text is never
rewritten.

The decision model is swappable:

- **Hosted:** TypeSafe Jev, Cloudflare Clef and Clef-Flash, or any endpoint that speaks the
  SystemOne request format.
- **Local:** Ollama, SGLang, laya-serve, or any server exposing `/v1/systemone`.
- **No model:** a rules-based scorer that runs offline and doubles as the fallback.

Hosts: Claude Code first. Codex and Antigravity are planned.

## Status

Pre-alpha. The core library, the model adapters and the Claude Code plugin are built and unit
tested; the plugin has not yet been run against live sessions. Nothing is published to npm yet.

## Install in Claude Code

Needs Claude Code 2.1.275 or later (function-hook plugins are an early-access API). At a
terminal session's prompt:

```
/plugin install agent-context-pruner --marketplace 9Tech-Solutions/agent-context-pruner
```

Answer `y` to add the marketplace, pick a scope, then set the options (or leave the defaults).
From then on `/compact` and auto-compaction go through the plugin. A toast says what happened:
`kept N/M messages, no summary (…)` when the pruned history replaced the summary, or
`fallback to built-in summary (…)` when it could not remove enough or the model failed.

### Choosing the decision model

| `provider`   | Uses                                    | Configure                                              |
| ------------ | --------------------------------------- | ------------------------------------------------------ |
| `auto`       | the first one available, in table order | nothing                                                |
| `typesafe`   | TypeSafe Jev                            | `TYPESAFE_API_KEY` or the `apiKey` option              |
| `cloudflare` | Cloudflare Workers AI Clef              | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`     |
| `ollama`     | a local Ollama 0.35+                    | `model` (default `nimble`), `baseUrl` if not localhost |
| `custom`     | any `/v1/systemone` server              | `baseUrl` and `model`                                  |
| `heuristic`  | the built-in rules, no network          | nothing                                                |

`auto` tries TypeSafe, then Cloudflare, then the rules. When the chosen model is unavailable or
fails, the plugin prunes with the rules instead (`fallbackToHeuristic`, on by default). Other
options: `keepThreshold`, `preserveRecentMessages` (6), `compactAtPercent` (60, `0` turns the
plugin's own auto-compaction off), `minReductionRatio` (0.25), `truncateHeadChars` (300).

Keys are read from the environment or the plugin's secure `apiKey` option. Never put them in a
file in this repository.

## How it works

1. Every tool call is paired with its result. Calls in the first message and the newest
   messages are pinned and never touched.
2. For models that read context, the whole conversation is sent as state, with every tool
   result replaced by a short note (`ok, 4213 chars (omitted)`). If it is too big for the
   model, it is shrunk in stages: tool inputs truncated, long texts abridged, old messages
   collapsed, old calls reduced to one line.
3. The model answers two questions per call: should the call stay, and should its full result
   stay verbatim.
4. Against the model's keep threshold, each call is kept whole, kept with its result truncated
   to a short head, or dropped together with its result.

## Usage (library)

```ts
import { compact, reductionRatio } from "@9tech.solutions/pruner-domain";
import {
  createSystemOneModel,
  createHeuristicModel,
  fetchTransport,
} from "@9tech.solutions/pruner-models";

const jev = createSystemOneModel(
  { profile: "typesafe", apiKey: process.env.TYPESAFE_API_KEY },
  fetchTransport(),
);
const model = jev.ok ? jev.value : createHeuristicModel();

const result = await compact(messages, model, { preserveRecentMessages: 6 });
if (result.ok && reductionRatio(result.value) >= 0.25) {
  // use result.value.messages
}
```

| Profile      | Server                                 | Needs                 |
| ------------ | -------------------------------------- | --------------------- |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone` | `apiKey`              |
| `cloudflare` | Workers AI `@cf/cloudflare/clef`       | `apiKey`, `accountId` |
| `ollama`     | `http://localhost:11434/v1/systemone`  | Ollama 0.35+          |
| `custom`     | `<baseUrl>/v1/systemone`               | `baseUrl`, `model`    |

## Repository layout

| Path                      | Package                               | What it holds                                                        |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `packages/domain`         | `@9tech.solutions/pruner-domain`      | Core logic and the `DecisionModel` port, zero deps                   |
| `packages/models`         | `@9tech.solutions/pruner-models`      | SystemOne adapter with profiles, rules-based model                   |
| `apps/claude-code-plugin` | `@9tech.solutions/pruner-claude-code` | Claude Code plugin: hook source and the installable `plugin/` folder |

## Development

Built with [Vite+](https://viteplus.dev) on Bun.

```sh
bun install
bun run ready   # format, lint, type check, test, build
```

See [AGENTS.md](AGENTS.md) for the architecture rules.

## License

[PolyForm Shield 1.0.0](LICENSE): free to use (at work too), fork, and contribute. You may not
use it to provide a product that competes with it. This makes the project source-available,
not OSI open source.

Parts of the core logic are adapted from
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) under the
MIT license; see [NOTICE](NOTICE).

Maintained by [9Tech Solutions](https://github.com/9Tech-Solutions).
