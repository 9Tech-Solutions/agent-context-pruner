import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

type ObjectValue = Record<string, unknown>;
type RpcMessage = ObjectValue & { method?: string; id?: number; params?: ObjectValue };

interface UpstreamRequest {
  readonly path: string;
  readonly body: ObjectValue;
}

interface PruneCount {
  readonly characters: number;
  readonly results: number;
}

interface UpstreamState {
  readonly requests: UpstreamRequest[];
  readonly autoUsage: boolean;
  highUsageSent: boolean;
  responseId: number;
  toolIssued: boolean;
}

interface InitialPrune {
  readonly home: string;
  readonly threadId: string;
  readonly rpc: Rpc;
  readonly beforeTool: number;
  readonly largeRequest: UpstreamRequest;
  readonly prunedRequest: UpstreamRequest;
}

const launcher = fileURLToPath(new URL("./stock-launch.mjs", import.meta.url));
const largeResult = "REAL_OLD_RESULT_".repeat(4_000) + "REAL_OLD_RESULT_TAIL_MUST_BE_REMOVED";
const storedSourceMarker = "REAL_OLD_RESULT_".repeat(20);

function isRecord(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolCall(): ObjectValue {
  return {
    type: "custom_tool_call",
    id: "ctc_stock_probe",
    call_id: "runtime_probe",
    name: "exec",
    input: [
      'if (!ALL_TOOLS.some(t => t.name.endsWith("exec_command"))) throw new Error("Tool discovery failed");',
      "const tokenProbe = await tools.exec_command({cmd: " +
        JSON.stringify('node -e "process.exit(process.env.CODEX_PRUNER_PROXY_TOKEN ? 7 : 0)"') +
        ", login: false});",
      'if (tokenProbe.exit_code !== 0) throw new Error("Proxy token reached a tool child");',
      'const result = await tools.exec_command({cmd:"cat pruner-stock-smoke-input.txt",login:false,max_output_tokens:20000,yield_time_ms:10000});',
      'if (result.exit_code !== 0 || !result.output.startsWith("CODEX_COMMAND_OK")) throw new Error("Local file read failed");',
      'text("CODEX_EXEC_PIPELINE_OK");',
      "text(result.output);",
    ].join("\n"),
  };
}

function responseItem(body: ObjectValue, state: UpstreamState): ObjectValue {
  const input = JSON.stringify(body["input"]) ?? "";
  if (input.includes('"type":"compaction_trigger"')) {
    return {
      type: "compaction",
      id: `cmp_stock_${state.responseId}`,
      encrypted_content: "mock_stock_checkpoint",
    };
  }
  if (!state.toolIssued && input.includes("Execute the runtime tool probe.")) {
    state.toolIssued = true;
    return toolCall();
  }
  return {
    type: "message",
    id: `msg_stock_${state.responseId}`,
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "STOCK_SMOKE_REPLY" }],
  };
}

function sendResponse(
  body: ObjectValue,
  path: string,
  response: ServerResponse,
  state: UpstreamState,
): void {
  state.requests.push({ path, body });
  const id = `resp_stock_${++state.responseId}`;
  const item = responseItem(body, state);
  const input = JSON.stringify(body["input"]) ?? "";
  const compaction = input.includes('"type":"compaction_trigger"');
  const inputTokens =
    state.autoUsage && !state.highUsageSent && !compaction
      ? 30_000
      : Math.max(1, Math.ceil(input.length / 4));
  if (state.autoUsage && !compaction) state.highUsageSent = true;
  const usage = {
    input_tokens: inputTokens,
    output_tokens: 8,
    total_tokens: inputTokens + 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  let body = Buffer.concat(chunks);
  if (request.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
  return body;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: UpstreamState,
): Promise<void> {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)
    .pathname;
  if (request.method === "GET" && path.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"object":"list","data":[]}');
    return;
  }
  if (request.method !== "POST" || !path.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  const parsed: unknown = JSON.parse((await requestBody(request)).toString("utf8"));
  if (!isRecord(parsed)) throw new Error("Fake Responses server received a non-object body");
  sendResponse(parsed, path, response, state);
}

async function startUpstream(autoUsage = false): Promise<{
  readonly state: UpstreamState;
  readonly url: string;
  close(): Promise<void>;
}> {
  const state: UpstreamState = {
    requests: [],
    autoUsage,
    highUsageSent: false,
    responseId: 0,
    toolIssued: false,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("synthetic smoke server error\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    state,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function configureHome(home: string, autoCompact: boolean): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-smoke-key" })}\n`,
  );
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-6.1-sol"',
      "model_context_window = 128000",
      `model_auto_compact_token_limit = ${autoCompact ? 20000 : 1000000}`,
      'model_auto_compact_token_limit_scope = "total"',
      ...(autoCompact ? [] : ["model_post_turn_compact_threshold_percent = 0"]),
      "[features]",
      "code_mode = true",
      "apps = false",
      "[features.code_mode_host]",
      "enabled = true",
      "disable_in_process_fallback = true",
    ].join("\n"),
  );
}

class Rpc {
  readonly events: RpcMessage[] = [];
  readonly pruneCounts: PruneCount[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }
  >();
  private failure: Error | undefined;

  constructor(binary: string, home: string, upstream: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: home,
      CODEX_PRUNER_UPSTREAM: upstream,
    };
    for (const name of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_CONTEXT_PRUNER_COMMAND",
      "CODEX_PRUNER_BYPASS",
    ])
      delete env[name];
    this.child = spawn(process.execPath, [launcher, binary, "app-server", "--stdio"], {
      cwd: home,
      env,
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`app-server exited (${code})`)));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private readStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString("utf8");
    let index: number;
    while ((index = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      const match = line.match(
        /^\[context-pruner\] removed (\d+) characters from (\d+) old tool results$/,
      );
      if (match) this.pruneCounts.push({ characters: Number(match[1]), results: Number(match[2]) });
    }
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.fail(new Error("app-server emitted invalid protocol JSON"));
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message["error"]) pending.reject(new Error(JSON.stringify(message["error"])));
        else if (isRecord(message["result"])) pending.resolve(message["result"]);
        else pending.reject(new Error("app-server returned a non-object result"));
      } else this.events.push(message);
    }
  }

  async call(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    const result = new Promise<ObjectValue>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return Promise.race([
      result,
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error(`Timed out: ${method}`);
      }),
    ]);
  }

  async wait(method: string, after: number): Promise<RpcMessage> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      const event = this.events.slice(after).find((candidate) => candidate.method === method);
      if (event) return event;
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  async initialize(): Promise<void> {
    await this.call("initialize", {
      clientInfo: { name: "stock_pruner_smoke", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = once(this.child, "exit");
    this.child.stdin.end();
    await Promise.race([
      exit,
      delay(5_000, undefined, { ref: false }).then(() => {
        this.child.kill();
      }),
    ]);
  }
}

async function startThread(rpc: Rpc, home: string): Promise<string> {
  await rpc.initialize();
  const started = await rpc.call("thread/start", {
    cwd: home,
    baseInstructions: "Use tools only when asked. This is a synthetic local smoke test.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    experimentalRawEvents: true,
  });
  const thread = started["thread"];
  assert(isRecord(thread) && typeof thread["id"] === "string", "thread/start did not return an id");
  return thread["id"];
}

async function turn(rpc: Rpc, threadId: string, text: string): Promise<void> {
  const after = rpc.events.length;
  await rpc.call("turn/start", { threadId, input: [{ type: "text", text }] });
  const done = await rpc.wait("turn/completed", after);
  const result = done.params?.["turn"];
  assert(isRecord(result), "turn/completed did not include a turn");
  assert.equal(result["status"], "completed", JSON.stringify(result["error"]));
}

async function snapshot(rpc: Rpc, threadId: string): Promise<string> {
  const result = await rpc.call("thread/read", { threadId, includeTurns: true });
  return JSON.stringify(result);
}

function injectAgedFixture(rpc: Rpc, threadId: string): Promise<ObjectValue> {
  const items: ObjectValue[] = [
    {
      type: "function_call",
      name: "exec_command",
      call_id: "failed_probe",
      arguments: '{"cmd":"synthetic failed probe"}',
    },
    {
      type: "function_call_output",
      call_id: "failed_probe",
      output: "FAILED_RESULT_MUST_SURVIVE: synthetic command failure",
      is_error: true,
    },
    ...Array.from({ length: 170 }, (_, index) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `AGE_MARKER_${index}` }],
    })),
    {
      type: "function_call",
      name: "exec_command",
      call_id: "recent_probe",
      arguments: '{"cmd":"synthetic recent probe"}',
    },
    {
      type: "function_call_output",
      call_id: "recent_probe",
      output: "RECENT_RESULT_MUST_SURVIVE",
    },
  ];
  return rpc.call("thread/inject_items", { threadId, items });
}

function bodyInput(request: UpstreamRequest): string {
  return JSON.stringify(request.body["input"]) ?? "";
}

function lastResponseRequest(state: UpstreamState, after: number): UpstreamRequest {
  const request = state.requests
    .slice(after)
    .findLast((candidate) => candidate.path.endsWith("/responses"));
  assert(request, "No upstream Responses request was captured");
  return request;
}

function inputBytes(request: UpstreamRequest): number {
  return Buffer.byteLength(bodyInput(request));
}

function assertToolOutputRequest(request: UpstreamRequest): void {
  const input = bodyInput(request);
  assert(input.includes("CODEX_EXEC_PIPELINE_OK"), "The native code-mode exec tool did not return");
  assert(
    input.includes("REAL_OLD_RESULT_TAIL_MUST_BE_REMOVED"),
    "The large fixture was not read locally",
  );
}

function assertPrunedRequest(request: UpstreamRequest): void {
  const input = bodyInput(request);
  assert(
    !input.includes("REAL_OLD_RESULT_TAIL_MUST_BE_REMOVED"),
    "The old tool result reached the upstream",
  );
  assert(
    input.includes("agent-context-pruner truncated"),
    "The old tool result has no pruning note",
  );
  assert(input.includes("USER_GOAL_MUST_SURVIVE"), "The user's goal disappeared");
  assert(input.includes("RECENT_RESULT_MUST_SURVIVE"), "The recent result disappeared");
  assert(
    input.includes("FAILED_RESULT_MUST_SURVIVE: synthetic command failure"),
    "The failed result changed",
  );
  assert(input.includes('"call_id":"runtime_probe"'), "The original exec call disappeared");
  assert(
    input.includes("pruner-stock-smoke-input.txt"),
    "The original exec call arguments changed",
  );
  assert(input.includes('"call_id":"recent_probe"'), "The recent call disappeared");
  assert(input.includes('"call_id":"failed_probe"'), "The failed call disappeared");
  assert(input.includes("AGE_MARKER_169"), "The injected history disappeared");
}

async function runPruningCase(
  binary: string,
  upstream: string,
  state: UpstreamState,
  root: string,
): Promise<{
  readonly report: ObjectValue;
  readonly home: string;
  readonly threadId: string;
  readonly resumed: Rpc;
  readonly rpcs: readonly Rpc[];
}> {
  const initial = await runInitialPrune(binary, upstream, state, root);
  const resumed = await resumePrunedThread(binary, upstream, state, initial);
  return {
    report: {
      name: "real-code-mode-prune-and-resume",
      status: "passed",
      modelRequests: state.requests.length - initial.beforeTool,
      largerInputBytes: inputBytes(initial.largeRequest),
      prunedInputBytes: inputBytes(initial.prunedRequest),
      rePrunedAfterResume: true,
      persistedOriginalRetained: true,
    },
    home: initial.home,
    threadId: initial.threadId,
    resumed,
    rpcs: [initial.rpc, resumed],
  };
}

async function runInitialPrune(
  binary: string,
  upstream: string,
  state: UpstreamState,
  root: string,
): Promise<InitialPrune> {
  const home = join(root, "prune-resume");
  configureHome(home, false);
  writeFileSync(join(home, "pruner-stock-smoke-input.txt"), `CODEX_COMMAND_OK\n${largeResult}\n`);
  const rpc = new Rpc(binary, home, upstream);
  const beforeTool = state.requests.length;
  try {
    const threadId = await startThread(rpc, home);
    await turn(rpc, threadId, "USER_GOAL_MUST_SURVIVE: Execute the runtime tool probe.");
    const initialRequests = state.requests.slice(beforeTool);
    assert.equal(initialRequests.length, 2, "The model did not receive the native exec result");
    const largeRequest = initialRequests.at(-1)!;
    assertToolOutputRequest(largeRequest);
    await injectAgedFixture(rpc, threadId);
    const beforePrune = state.requests.length;
    await turn(rpc, threadId, "Continue after the real local tool call.");
    const prunedRequest = lastResponseRequest(state, beforePrune);
    assertPrunedRequest(prunedRequest);
    assert(
      inputBytes(prunedRequest) < inputBytes(largeRequest),
      "The next upstream request did not get smaller",
    );
    assert(
      rpc.pruneCounts.some((count) => count.results > 0),
      "The proxy emitted no count-only prune record",
    );
    const rawSnapshot = await snapshot(rpc, threadId);
    assert(
      rawSnapshot.includes(storedSourceMarker),
      "The original tool output is missing from the saved thread",
    );
    return { home, threadId, rpc, beforeTool, largeRequest, prunedRequest };
  } catch (error) {
    await rpc.close();
    throw new Error(
      `real-code-mode-prune-and-resume: ${error instanceof Error ? error.message : "smoke failed"}`,
    );
  }
}

async function resumePrunedThread(
  binary: string,
  upstream: string,
  state: UpstreamState,
  initial: InitialPrune,
): Promise<Rpc> {
  await initial.rpc.close();
  const resumed = new Rpc(binary, initial.home, upstream);
  try {
    await resumed.initialize();
    await resumed.call("thread/resume", { threadId: initial.threadId });
    const saved = await snapshot(resumed, initial.threadId);
    assert(saved.includes(storedSourceMarker), "The original tool output did not survive restart");
    const beforeResume = state.requests.length;
    await turn(resumed, initial.threadId, "Continue after restarting the app server.");
    assertPrunedRequest(lastResponseRequest(state, beforeResume));
    return resumed;
  } catch (error) {
    await resumed.close();
    throw error;
  }
}

async function waitForCompaction(
  state: UpstreamState,
  after: number,
  timeoutMs: number,
): Promise<UpstreamRequest | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = state.requests
      .slice(after)
      .find((candidate) => bodyInput(candidate).includes('"type":"compaction_trigger"'));
    if (request) return request;
    await delay(25);
  }
  return undefined;
}

function compactionResponseId(request: UpstreamRequest, state: UpstreamState): string {
  const trigger = bodyInput(request);
  assert(
    trigger.includes("REAL_OLD_RESULT_"),
    "The native compaction request did not contain its source history",
  );
  const id = `resp_stock_${state.requests.indexOf(request) + 1}`;
  return id;
}

function assertCheckpointContinuation(request: UpstreamRequest, responseId: string): void {
  const serialized = JSON.stringify(request.body);
  assert(
    serialized.includes("mock_stock_checkpoint") ||
      request.body["previous_response_id"] === responseId,
    "The native compaction checkpoint was not used for continuation",
  );
}

async function runManualCompactionCase(
  binary: string,
  upstream: string,
  state: UpstreamState,
  home: string,
  threadId: string,
  rpc: Rpc,
): Promise<{ readonly report: ObjectValue; readonly resumed: Rpc }> {
  const before = state.requests.length;
  const pruneCountBefore = rpc.pruneCounts.length;
  const eventIndex = rpc.events.length;
  await rpc.call("thread/compact/start", { threadId });
  await rpc.wait("turn/completed", eventIndex);
  const compactRequest = await waitForCompaction(state, before, 5_000);
  assert(compactRequest, "Manual native compaction did not reach the synthetic upstream");
  assert.equal(
    rpc.pruneCounts.length,
    pruneCountBefore,
    "The compaction-trigger request was pruned",
  );
  const responseId = compactionResponseId(compactRequest, state);
  const beforeContinue = state.requests.length;
  await turn(rpc, threadId, "Continue after manual native compaction.");
  const continued = lastResponseRequest(state, beforeContinue);
  assertCheckpointContinuation(continued, responseId);
  await rpc.close();
  const resumed = await resumeCompactedThread(binary, upstream, state, home, threadId);
  return {
    report: {
      name: "manual-native-remote-compaction",
      status: "passed",
      compactionRequests: 1,
      checkpointContinued: true,
      resumedAfterCompaction: true,
    },
    resumed,
  };
}

async function resumeCompactedThread(
  binary: string,
  upstream: string,
  state: UpstreamState,
  home: string,
  threadId: string,
): Promise<Rpc> {
  const resumed = new Rpc(binary, home, upstream);
  try {
    await resumed.initialize();
    await resumed.call("thread/resume", { threadId });
    const beforeResume = state.requests.length;
    await turn(resumed, threadId, "Continue after restarting the compacted thread.");
    assert(
      state.requests.length > beforeResume,
      "The resumed compacted thread made no upstream request",
    );
    return resumed;
  } catch (error) {
    await resumed.close();
    throw error;
  }
}

async function runAutomaticCompactionCase(
  binary: string,
  upstream: string,
  state: UpstreamState,
  root: string,
): Promise<ObjectValue> {
  const home = join(root, "automatic-native-compaction");
  configureHome(home, true);
  const rpc = new Rpc(binary, home, upstream);
  try {
    return await exerciseAutomaticCompaction(rpc, state, home);
  } finally {
    await rpc.close();
  }
}

async function exerciseAutomaticCompaction(
  rpc: Rpc,
  state: UpstreamState,
  home: string,
): Promise<ObjectValue> {
  const threadId = await startThread(rpc, home);
  await rpc.call("thread/inject_items", {
    threadId,
    items: Array.from({ length: 170 }, (_, index) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `AUTO_AGE_MARKER_${index}` }],
    })),
  });
  const compact = await induceAutomaticCompaction(rpc, state, threadId);
  assert(compact, "Stock Codex did not emit automatic compaction after high-usage turns");
  assert(
    bodyInput(compact).includes('"type":"compaction_trigger"'),
    "Automatic compaction used an unexpected route",
  );
  await continueAutomaticCompaction(rpc, state, threadId, compact);
  return {
    name: "automatic-native-compaction",
    status: "passed",
    compactionRequests: 1,
    highUsageReported: true,
  };
}

async function induceAutomaticCompaction(
  rpc: Rpc,
  state: UpstreamState,
  threadId: string,
): Promise<UpstreamRequest | undefined> {
  await turn(rpc, threadId, "Trigger synthetic high-usage accounting.");
  let compact = await waitForCompaction(state, 0, 2_000);
  if (!compact) {
    await turn(rpc, threadId, "Continue after synthetic high-usage accounting.");
    compact = await waitForCompaction(state, 0, 5_000);
  }
  return compact;
}

async function continueAutomaticCompaction(
  rpc: Rpc,
  state: UpstreamState,
  threadId: string,
  compact: UpstreamRequest,
): Promise<void> {
  const compactIndex = state.requests.indexOf(compact);
  const continued = state.requests
    .slice(compactIndex + 1)
    .some((request) => !bodyInput(request).includes('"type":"compaction_trigger"'));
  if (continued) return;
  const before = state.requests.length;
  await turn(rpc, threadId, "Continue after automatic native compaction.");
  assert(
    state.requests
      .slice(before)
      .some((request) => !bodyInput(request).includes('"type":"compaction_trigger"')),
    "The automatically compacted thread did not continue",
  );
}

async function runCases(
  binary: string,
  upstream: Awaited<ReturnType<typeof startUpstream>>,
  root: string,
  rpcs: Rpc[],
  cases: ObjectValue[],
): Promise<Awaited<ReturnType<typeof startUpstream>>> {
  const pruning = await runPruningCase(binary, upstream.url, upstream.state, root);
  rpcs.push(...pruning.rpcs);
  cases.push(pruning.report);
  const manual = await runManualCompactionCase(
    binary,
    upstream.url,
    upstream.state,
    pruning.home,
    pruning.threadId,
    pruning.resumed,
  );
  rpcs.push(manual.resumed);
  cases.push(manual.report);
  await manual.resumed.close();
  const autoServer = await startUpstream(true);
  cases.push(await runAutomaticCompactionCase(binary, autoServer.url, autoServer.state, root));
  return autoServer;
}

async function main(): Promise<void> {
  const binary = process.argv[2];
  assert(
    binary && isAbsolute(binary) && existsSync(binary),
    "Pass an absolute official Codex executable or bin/codex.js path.",
  );
  assert(existsSync(launcher), `Build the stock launcher first: ${launcher}`);
  const root = mkdtempSync(join(tmpdir(), "context-pruner-stock-smoke-"));
  const rpcs: Rpc[] = [];
  const cases: ObjectValue[] = [];
  const upstream = await startUpstream();
  let autoServer: Awaited<ReturnType<typeof startUpstream>> | undefined;
  try {
    autoServer = await runCases(binary, upstream, root, rpcs, cases);
  } finally {
    for (const rpc of rpcs) await rpc.close();
    await autoServer?.close();
    await upstream.close();
  }
  const allRequests = [...upstream.state.requests, ...(autoServer?.state.requests ?? [])];
  const pruneCounts = rpcs.flatMap((rpc) => rpc.pruneCounts);
  const report = {
    synthetic: true,
    executable: binary,
    cases,
    counts: {
      upstreamRequests: allRequests.length,
      compactionRequests: allRequests.filter((request) =>
        bodyInput(request).includes('"type":"compaction_trigger"'),
      ).length,
      prunedResults: pruneCounts.reduce((total, count) => total + count.results, 0),
      removedCharacters: pruneCounts.reduce((total, count) => total + count.characters, 0),
    },
    report: join(root, "report.json"),
  };
  writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Stock Codex smoke failed"}\n`,
    );
    process.exitCode = 1;
  });
}
