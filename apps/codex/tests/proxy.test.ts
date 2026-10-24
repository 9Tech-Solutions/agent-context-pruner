import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vite-plus/test";
import { startProxy } from "../src/proxy.ts";

const servers: Server[] = [];
const proxies: { close(): Promise<void> }[] = [];
const token = "synthetic-local-proxy-token";

async function upstream(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return "http://127.0.0.1:" + address.port + "/backend-api/codex";
}

async function proxy(target: string) {
  const result = await startProxy({ upstream: target, token });
  proxies.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((item) => item.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it("forwards model queries and authorization without leaking the local proxy token", async () => {
  const target = await upstream((req, res) => {
    expect(req.url).toBe("/backend-api/codex/models?client_version=0.164.0");
    expect(req.headers.authorization).toBe("Bearer synthetic-upstream-token");
    expect(req.headers["x-codex-pruner-token"]).toBeUndefined();
    res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
    res.end('{"error":"retry later"}');
  });
  const local = await proxy(target);
  const result = await fetch(local.url + "/models?client_version=0.164.0", {
    headers: { "x-codex-pruner-token": token, authorization: "Bearer synthetic-upstream-token" },
  });
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("5");
  expect(await result.text()).toBe('{"error":"retry later"}');
});

it("streams Responses events before the upstream response completes", async () => {
  let finish: (() => void) | undefined;
  const target = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: last\n\n");
  });
  const local = await proxy(target);
  const result = await fetch(local.url + "/responses", {
    method: "POST",
    headers: { "x-codex-pruner-token": token, "content-type": "application/json" },
    body: JSON.stringify({ input: [], stream: true }),
  });
  const reader = result.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: first");
  finish!();
  let remaining = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    remaining += new TextDecoder().decode(part.value);
  }
  expect(remaining).toContain("data: last");
});

it("prunes aged text results while preserving calls and the user's current request", async () => {
  const input: unknown[] = Array.from({ length: 8 }, (_, i) => ({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "earlier " + i }],
  }));
  input.push(
    {
      type: "function_call",
      call_id: "old-call",
      name: "exec_command",
      arguments: '{"cmd":"Get-Content fixture.txt"}',
    },
    {
      type: "function_call_output",
      call_id: "old-call",
      output: "old successful fixture output\n".repeat(1000),
    },
  );
  input.push(
    ...Array.from({ length: 170 }, (_, i) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "later " + i }],
    })),
  );
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Keep doing the requested work" }],
  });
  const original = { model: "synthetic-model", stream: true, input };
  let forwarded: typeof original | undefined;
  const target = await upstream(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    forwarded = JSON.parse(Buffer.concat(chunks).toString()) as typeof original;
    res.end("ok");
  });
  const local = await proxy(target);
  const result = await fetch(local.url + "/responses", {
    method: "POST",
    headers: { "x-codex-pruner-token": token },
    body: JSON.stringify(original),
  });
  expect(await result.text()).toBe("ok");
  expect(JSON.stringify(forwarded).length).toBeLessThan(JSON.stringify(original).length - 10000);
  expect(forwarded!.input[8]).toEqual(input[8]);
  expect(forwarded!.input.at(-1)).toEqual(input.at(-1));
  expect(local.stats.editedResults).toBe(1);
  expect(local.stats.removedCharacters).toBeGreaterThan(10000);
});

it("forwards malformed JSON and native compaction payloads unchanged", async () => {
  const received: string[] = [];
  const target = await upstream(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks).toString());
    res.end("ok");
  });
  const local = await proxy(target);
  const bodies = ["{ malformed", '{ "input": [{"type":"compaction_trigger"}], "stream": true }'];
  for (const body of bodies) {
    const result = await fetch(local.url + "/responses", {
      method: "POST",
      headers: { "x-codex-pruner-token": token },
      body,
    });
    await result.text();
  }
  expect(received).toEqual(bodies);
  expect(local.stats.editedResults).toBe(0);
});

it("rejects missing tokens, browser origins, unsupported routes, and redirects", async () => {
  let calls = 0;
  const target = await upstream((_req, res) => {
    calls++;
    res.writeHead(307, { location: "https://example.invalid/credentials-must-not-follow" });
    res.end();
  });
  const local = await proxy(target);
  expect((await fetch(local.url + "/models")).status).toBe(403);
  expect(
    (
      await fetch(local.url + "/models", {
        headers: { "x-codex-pruner-token": token, origin: "https://example.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(local.url + "/not-allowed", {
        headers: { "x-codex-pruner-token": token },
      })
    ).status,
  ).toBe(404);
  const response = await fetch(local.url + "/models", {
    headers: { "x-codex-pruner-token": token },
    redirect: "manual",
  });
  expect(response.status).toBe(502);
  expect(calls).toBe(1);
});

it("does not let a redirect-following client send its local token to another origin", async () => {
  let escaped = 0;
  const otherOrigin = await upstream((_req, res) => {
    escaped++;
    res.end("unexpected redirect");
  });
  const target = await upstream((_req, res) => {
    res.writeHead(307, { location: otherOrigin + "/models" });
    res.end();
  });
  const local = await proxy(target);
  const response = await fetch(local.url + "/models", {
    headers: { "x-codex-pruner-token": token },
  });
  expect(response.status).toBe(502);
  expect(escaped).toBe(0);
});

it("rejects upstream URLs that would expose credentials on an insecure remote connection", async () => {
  await expect(startProxy({ upstream: "http://example.invalid/v1", token })).rejects.toThrow();
  await expect(
    startProxy({ upstream: "https://user:password@example.invalid/v1", token }),
  ).rejects.toThrow();
});

it("passes encoded request bytes through unchanged", async () => {
  const encoded = gzipSync(Buffer.from('{"input":[],"synthetic":"compressed"}'));
  let captured = Buffer.alloc(0);
  const target = await upstream(async (req, res) => {
    expect(req.headers["content-encoding"]).toBe("gzip");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured = Buffer.concat(chunks);
    res.end("ok");
  });
  const local = await proxy(target);
  const response = await fetch(local.url + "/responses", {
    method: "POST",
    headers: { "x-codex-pruner-token": token, "content-encoding": "gzip" },
    body: encoded,
  });
  expect(await response.text()).toBe("ok");
  expect(captured).toEqual(encoded);
  expect(local.stats.editedResults).toBe(0);
});

it("bounds oversized requests without forwarding a partial history", async () => {
  let forwarded = false;
  const target = await upstream((_req, res) => {
    forwarded = true;
    res.end();
  });
  const local = await proxy(target);
  const response = await fetch(local.url + "/responses", {
    method: "POST",
    headers: { "x-codex-pruner-token": token },
    body: Buffer.alloc(32 * 1024 * 1024 + 1, 32),
  });
  expect(response.status).toBe(413);
  expect(forwarded).toBe(false);
  await response.text();
});

it("returns a generic upstream failure without leaking authorization", async () => {
  const target = await upstream((req) => req.destroy());
  const local = await proxy(target);
  const response = await fetch(local.url + "/models", {
    headers: { "x-codex-pruner-token": token, authorization: "Bearer synthetic-sensitive-token" },
  });
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("context-pruner: upstream request failed\n");
});
