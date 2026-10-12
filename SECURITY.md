# Security

This project handles API keys and sends conversation transcripts to the decision model you
choose, so bugs that leak either are security issues. Examples:

- a provider's key sent anywhere but that provider's own host
- transcript text written to a log, an error message, an eval report or any place it was not
  configured to go
- the local model server reachable beyond the address it was told to listen on

Report them privately to **info@9tech.solutions** with the version, the steps to reproduce and
what leaked. Please do not open a public issue for them.

Everything else is an ordinary bug: open an issue.
