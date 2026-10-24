# Security

This project handles API keys and sends conversation transcripts to the decision model you
choose, so bugs that leak either are security issues. Examples:

- a provider's key sent anywhere but that provider's own host
- transcript text written to a log, an error message, an eval report or any place it was not
  configured to go
- the local model server reachable beyond the address it was told to listen on
- the Codex proxy forwarding credentials to a different upstream or exposing its local token
  to a tool subprocess

The stock Codex proxy uses the offline heuristic and forwards model requests to the selected
OpenAI upstream. It binds to loopback, requires a per-launch token, and rejects redirects.
It does not log credentials or transcripts. Saved Codex transcripts retain the original tool
output; proxy pruning changes outgoing requests only. See [the adapter limits](apps/codex/README.md)
before using it with custom routing or managed configuration.

Report them privately to **info@9tech.solutions** with the version, the steps to reproduce and
what leaked. Please do not open a public issue for them.

Everything else is an ordinary bug: open an issue.
