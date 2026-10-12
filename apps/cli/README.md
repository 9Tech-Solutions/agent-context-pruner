# @9tech.solutions/pruner-cli

Measure how well a decision model would prune your own Claude Code sessions, with
[agent-context-pruner](https://github.com/9Tech-Solutions/agent-context-pruner)'s evaluation.

```sh
npx @9tech.solutions/pruner-cli eval ~/.claude/projects/<project>/<session>.jsonl --provider heuristic,typesafe
```

It picks a few points in each session where a compaction could have happened, asks each model
what it would keep, and reports for every keep threshold how much would be removed, how many
re-reads that causes, the net saving, and a ranking score (AUC: 0.5 is chance, 1 is perfect).
`--help` lists the options.

Network providers receive the session text, so pass only sessions you are allowed to send. Keys
come from `TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The `--json`
report holds scores, labels and error kinds, never transcript text.

Licensed under [PolyForm Shield 1.0.0](https://github.com/9Tech-Solutions/agent-context-pruner/blob/main/LICENSE).
