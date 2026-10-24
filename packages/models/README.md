# @9tech.solutions/pruner-models

Decision models for [agent-context-pruner](https://github.com/9Tech-Solutions/agent-context-pruner):

- **SystemOne** adapter with profiles for TypeSafe Jev, Cloudflare Workers AI Clef, Ollama 0.35+,
  and any other `/v1/systemone` server.
- **Rules-based** model: free, offline, ranks by how long ago a call ran.

```ts
import { createProviderModel, fetchTransport, keysFromEnv } from "@9tech.solutions/pruner-models";

const model = createProviderModel("typesafe", {}, keysFromEnv(process.env), fetchTransport());
```

Network access goes only through the `HttpTransport` you pass, so the same code runs under
Node, Bun, or a Claude Code hook. A hosted provider's key is only ever sent to that provider's
own host.

Licensed under [MIT](https://github.com/9Tech-Solutions/agent-context-pruner/blob/main/LICENSE).
