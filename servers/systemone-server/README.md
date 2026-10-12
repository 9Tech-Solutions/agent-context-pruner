# pruner-systemone-server

A local `/v1/systemone` server for agent-context-pruner. It wraps any model whose Python object
has a `system_one(state, questions)` method, such as
[LiquidAI/d1-3B](https://huggingface.co/LiquidAI/d1-3B), which ships no server of its own.
Point the plugin's `custom` provider at it and pruning decisions never leave your machine.

## Run it

```sh
cd servers/systemone-server
uv run --extra hf pruner-systemone-server --model LiquidAI/d1-3B --trust-remote-code
```

Then, in the Claude Code plugin's settings: `provider` = `custom`, `baseUrl` =
`http://localhost:8000`, `model` = `d1-3B` (the server ignores the name; the plugin requires one).

- `--trust-remote-code` runs the code the model repository ships. d1-3B needs it. Pass it only
  for models you trust.
- It listens on `127.0.0.1:8000` by default (`--host`, `--port`). On any other address, anyone
  who can reach the port can send it transcripts and read the answers, so it warns.
- Requests reach the model one at a time. Bodies over 8 MB are refused (`--max-body-mb`).
- Error responses and logs never quote the request: it holds your transcript.

## Hardware

d1-3B's card loads it in float32 on CPU (about 12.5 GB of weights) and bfloat16 on a GPU. Per
the card, a question takes about 8 ms on an RTX 4090 and a 3.4k-token state about 640 ms on an
M5 Pro. On a machine with 16 GB of RAM, use a GPU or a hosted provider instead.

## Develop

```sh
uv run pytest            # endpoint tests against a fake model: no torch, no download
uv run ruff check . && uv run ruff format --check .
```
