# @9tech.solutions/pruner-eval

The evaluation harness of [agent-context-pruner](https://github.com/9Tech-Solutions/agent-context-pruner).
It replays a recorded agent session at a few compaction points, asks a decision model for its
keep scores, and checks them against what the session did afterwards: text the model wrote
again is needed, and a keep threshold loses it only when every copy goes. For each threshold it
reports the reduction, the re-reads it would cause, the net saving, and a threshold-free AUC.

Most people want the command line instead:
[`@9tech.solutions/pruner-cli`](https://www.npmjs.com/package/@9tech.solutions/pruner-cli).

Licensed under [MIT](https://github.com/9Tech-Solutions/agent-context-pruner/blob/main/LICENSE).
