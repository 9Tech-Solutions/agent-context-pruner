# @9tech.solutions/pruner-domain

The core of [agent-context-pruner](https://github.com/9Tech-Solutions/agent-context-pruner):
context compaction for AI coding agents that never summarizes. It pairs tool calls with their
results, asks a decision model which old calls and results still matter, and drops or truncates
the rest. User and assistant text is never rewritten.

No dependencies, no I/O. Errors come back as `Result` values instead of throws.

```ts
import { compact } from "@9tech.solutions/pruner-domain";
import { createHeuristicModel } from "@9tech.solutions/pruner-models";

const result = await compact(messages, createHeuristicModel(), { preserveRecentMessages: 6 });
if (result.ok) console.log(result.value.stats);
```

A model is anything implementing the `DecisionModel` port. Ready-made ones are in
[`@9tech.solutions/pruner-models`](https://www.npmjs.com/package/@9tech.solutions/pruner-models).

Licensed under [MIT](https://github.com/9Tech-Solutions/agent-context-pruner/blob/main/LICENSE).
