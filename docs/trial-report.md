# Share a local trial

Run the evaluator on a saved Claude Code session with `--provider heuristic` to make zero
model requests. This evaluates a recorded session. It does not prune a live session.

From a repository clone, run `bun install` once, then evaluate a saved session:

```sh
bun apps/cli/src/main.ts eval /path/to/session.jsonl --provider heuristic
```

Keep your session file, source code, prompts, machine paths, credentials, and customer data on
your own machine. Share only aggregates you are comfortable making public. Hosted decision
models receive session content, so choose a provider deliberately.

Copy this template into a [new issue](https://github.com/9Tech-Solutions/agent-context-pruner/issues/new),
or send it through the channel where you volunteered. Remove any field you cannot share.

```text
Trial type: real local session / synthetic fixture
CLI version or commit:
Claude Code version:
Provider: heuristic
Task category (no private names or paths):
Threshold:
Scored calls:
Kept / truncated / dropped:
Needed / lost:
Reduction / net after re-reads:
Did the reported loss match something the next task actually needed?
Was any useful information missed by the reuse label?
Setup blocker or confusing step:
Where did you find the project?
Would you use it again? Why?
May we quote this report publicly? No, unless I explicitly say yes here.
```

The reuse label detects later verbatim reuse. It can miss a result that informed a decision
without being copied. A smaller context and a favorable retrospective score do not establish
task success, subscription savings, or lower billing.

If it helped, sharing your aggregate report with a colleague who has the same problem is useful.
A GitHub star is optional and helps you find the project again. Neither action is required to
use the evaluator or get support.
