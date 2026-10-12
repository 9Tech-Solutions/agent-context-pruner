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

Pre-alpha. The core library, the model adapters, the Claude Code plugin and the evaluation CLI
are built and unit tested, and the plugin has run in live Claude Code 2.1.296 sessions with
TypeSafe Jev. Nothing is published to npm yet.

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
fails, the plugin prunes with the rules instead (`fallbackToHeuristic`, on by default).

Every other setting is a picker in `/config` (or `/plugin` → the plugin → configure):
`keepThreshold` (`model default`), `compactAtPercent` (60, `off` leaves compaction to
`/compact` and Claude Code), `preCompactHooks` (`run`: see ECC below), `preserveRecentMessages`
(6), `minReductionRatio` (25%), `truncateHeadChars` (300), `noteDroppedCalls` (on: a dropped
call leaves a one-line note where its result was, so the model knows what to re-run),
`fallbackToHeuristic` (on), and `logEachDecision` (off: one summary line per compaction; on:
every scored call's keep scores).

Keys are read from the environment or the plugin's secure `apiKey` option. Never put them in a
file in this repository.

### Telling it what to keep

Text after `/compact` reaches the decision model as `instructions`, next to the goal (your last
three prompts): `/compact keep the auth plan and src/auth/session.ts`. Any file it names is kept
whole with every model, without asking the model; models that read the conversation weigh the
rest of the text when scoring each call.

### With ECC strategic-compact

[ECC](https://github.com/affaan-m/ECC)'s strategic-compact suggests
`/compact` at task-phase boundaries instead of at an arbitrary fill level. The two fit
together:

- Compact at the boundary it suggests, with the focus as instructions (above).
- Set `compactAtPercent` to `0`, so the plugin never compacts mid-task on its own. Claude Code's
  own threshold still compacts through the plugin when the window is nearly full.
- Classic `PreCompact` hooks still run, ECC's `pre-compact.js` included. Claude Code fires them only
  inside its own compaction, so before the pruned history is installed the plugin lets that
  compaction run on a short stand-in transcript (the last four text messages) and discards its
  summary, after telling it the summary is discarded so it answers in a line. A hook that blocks
  the compaction is respected. The cost is one small summary request per compaction, timed in the
  log with its output tokens; set `preCompactHooks` to `skip` to trade the hooks for speed.

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

## Measuring a model

`agent-context-pruner eval` replays your own Claude Code sessions to show what a model would
prune and what that would cost:

```sh
bun apps/cli/src/main.ts eval ~/.claude/projects/<project>/<session>.jsonl --provider heuristic,typesafe
```

It picks a few points in each session where a compaction could have happened, asks each model
for its keep scores there, and checks them against what the session did afterwards. Text the
model wrote again later (an `Edit` copying lines from a `Read`, a commit hash from `git log`, a
line from its own earlier `Write`) is needed when, before that point, only droppable tool calls
held it and nothing after the point supplied it again first. A threshold loses that text only
when it removes every copy, and each loss is charged one re-read of the call holding it. For
every keep threshold the report shows how much would be removed, how many re-reads that causes,
and the net saving after them. It also reports a threshold-free ranking score (AUC: 0.5 is
chance, 1 is perfect).

Network providers receive the session text, so pass only sessions you are allowed to send. The
`--json` report holds scores, labels and error kinds, never transcript text.

First measurement (2 sessions of building this project, 9 compaction points, 1,154 scored calls,
October 2026): 16% of scored calls held text reused later. Jev ranked those at 0.57 on its
keep-result score (barely above chance) and 0.65 on keep-call. Its net saving was 70% at the
0.5 default, the best of any threshold, so the default stands. The rules model ranked them at
0.39, so its size and edited-file rules tend to truncate the results that get reused, and saved
30% at its default. Two sessions from one person are a small sample, so treat these as a first
reading, not a benchmark.

## Repository layout

| Path                      | Package                               | What it holds                                                        |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `packages/domain`         | `@9tech.solutions/pruner-domain`      | Core logic and the `DecisionModel` port, zero deps                   |
| `packages/models`         | `@9tech.solutions/pruner-models`      | SystemOne adapter with profiles, rules-based model                   |
| `packages/eval`           | `@9tech.solutions/pruner-eval`        | Replays sessions and measures a model's keep threshold               |
| `apps/claude-code-plugin` | `@9tech.solutions/pruner-claude-code` | Claude Code plugin: hook source and the installable `plugin/` folder |
| `apps/cli`                | `@9tech.solutions/pruner-cli`         | `agent-context-pruner eval`: the evaluation from the command line    |

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
