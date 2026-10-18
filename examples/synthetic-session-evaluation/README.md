# Offline pruning evaluation example

This is a generated synthetic Claude Code session. It contains no real user transcript. The example shows what the evaluator reports when later-reused tool text is rare.

If workspace dependencies are not installed yet, run `bun install` once. Then, from the repository root, run:

```sh
bun apps/cli/src/main.ts eval ./examples/synthetic-session-evaluation/session.jsonl --provider heuristic --preserve 2 --cuts 1
```

The report prints to the terminal; this command writes no output file. The explicit `--provider heuristic` mode uses offline rules and makes no model API calls. It evaluates the saved session; it does not prune a live Claude Code session or establish that a future coding task will succeed.

The checked run scored 11 tool calls. Its recommended 0.05 threshold retained all calls, with no reduction. At 0.95, it kept one, truncated three and dropped seven. It lost the one later-reused result and reported -24% net savings. These synthetic results show a failure case, not real-world savings or task-success evidence.

The generated report contains aggregate evaluation results, not transcript text. The included `report.json` and `report-local.json` are example outputs. Choose a fresh path for each run. Keep real session logs on the user's machine and share an aggregate report or a minimal reproduction first.

To try the published npm package, run `npx --yes @9tech.solutions/pruner-cli@0.1.0` from outside the repository root and pass it the fixture's path. npm 11 rejects that command inside this checkout because its `devEngines.packageManager` requires Bun.
