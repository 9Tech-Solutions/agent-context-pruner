import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream";
import { once } from "node:events";
import { MAX_INPUT_BYTES } from "./input.ts";
import { pruneRequest } from "./proxy-prune.ts";

export interface ProxyStats {
  requests: number;
  editedResults: number;
  removedCharacters: number;
}

interface ProxyOptions {
  readonly upstream: string;
  readonly token: string;
  readonly onPruned?: (characters: number, results: number) => void;
}

function upstreamUrl(value: string): URL {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Proxy upstream must use HTTPS or loopback HTTP without credentials or query parameters",
    );
  }
  return url;
}

function cleanHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-codex-pruner-token",
  ]);
  for (const name of (source.connection ?? "").split(",")) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !excluded.has(key.toLowerCase())),
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) {
      // shortcut: bodies above 32 MiB are rejected; add streaming bypass if a real workload needs more.
      req.resume();
      return undefined;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function requestBody(
  req: IncomingMessage,
  stats: ProxyStats,
  options: ProxyOptions,
): Promise<Buffer | undefined> {
  const input = await readBody(req);
  if (!input || req.headers["content-encoding"]) return input;
  try {
    const parsed: unknown = JSON.parse(input.toString("utf8"));
    const pruned = await pruneRequest(parsed);
    if (pruned.editedResults === 0) return input;
    stats.editedResults += pruned.editedResults;
    stats.removedCharacters += pruned.removedCharacters;
    options.onPruned?.(pruned.removedCharacters, pruned.editedResults);
    return Buffer.from(JSON.stringify(pruned.body));
  } catch {
    return input;
  }
}

function relay(req: IncomingMessage, res: ServerResponse, target: URL, body?: Buffer): void {
  const headers = cleanHeaders(req.headers);
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const outgoing = send(target, { method: req.method, headers }, (incoming) => {
    if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) {
      incoming.resume();
      res
        .writeHead(502, { "content-type": "text/plain" })
        .end("context-pruner: upstream redirect refused\n");
      return;
    }
    res.writeHead(incoming.statusCode ?? 502, cleanHeaders(incoming.headers));
    pipeline(incoming, res, () => {});
  });
  outgoing.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("context-pruner: upstream request failed\n");
  });
  res.once("close", () => outgoing.destroy());
  outgoing.setTimeout(300_000, () => outgoing.destroy());
  outgoing.end(body);
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  target: URL,
  options: ProxyOptions,
  stats: ProxyStats,
): Promise<void> {
  if (
    req.headers.origin ||
    req.headers.host !== host ||
    req.headers["x-codex-pruner-token"] !== options.token
  ) {
    res.writeHead(403).end();
    return;
  }
  const path = new URL(req.url ?? "/", "http://" + host);
  if (
    !["/models", "/responses", "/responses/compact"].includes(path.pathname) ||
    path.host !== host
  ) {
    res.writeHead(404).end();
    return;
  }
  if (
    (path.pathname === "/models" && req.method !== "GET") ||
    (path.pathname !== "/models" && req.method !== "POST")
  ) {
    res.writeHead(405).end();
    return;
  }
  stats.requests++;
  const url = new URL(target);
  url.pathname = target.pathname.replace(/\/$/, "") + path.pathname;
  url.search = path.search;
  if (req.method === "GET") return relay(req, res, url);
  const body =
    path.pathname === "/responses" ? await requestBody(req, stats, options) : await readBody(req);
  if (body === undefined) {
    res.writeHead(413).end("context-pruner: request exceeds the 32 MiB proxy limit\n");
    return;
  }
  relay(req, res, url, body);
}

/** One authenticated loopback proxy per CLI process; credentials and transcripts are never logged. */
export async function startProxy(
  options: ProxyOptions,
): Promise<{ url: string; stats: ProxyStats; close(): Promise<void> }> {
  const target = upstreamUrl(options.upstream);
  if (!options.token) throw new Error("A local proxy token is required");
  const stats: ProxyStats = { requests: 0, editedResults: 0, removedCharacters: 0 };
  let host = "";
  const server = createServer((req, res) => {
    void serve(req, res, host, target, options, stats).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end("context-pruner: request failed\n");
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  host = "127.0.0.1:" + address.port;
  return {
    url: "http://" + host,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
