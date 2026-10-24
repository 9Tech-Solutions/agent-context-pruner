import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

type ObjectValue = Record<string, unknown>;
type RpcMessage = ObjectValue & { method?: string; id?: number; params?: ObjectValue };
type Route = "unsupported" | "v2";

const launcher = fileURLToPath(new URL("../dist/launch.mjs", import.meta.url));
const requests: ObjectValue[] = [];
let responseId = 0;
let pendingTool: ObjectValue | undefined;

function respond(body: ObjectValue, response: ServerResponse): void {
  requests.push(body);
  const id = `resp_smoke_${++responseId}`;
  const input = JSON.stringify(body["input"]);
  const remote = input.includes('"type":"compaction_trigger"');
  const text = input.includes("SUMMARIZE_SMOKE_HISTORY") ? "SMOKE_SUMMARY" : "SMOKE_REPLY";
  const item =
    pendingTool ??
    (remote
      ? { type: "compaction", id: `cmp_${responseId}`, encrypted_content: "mock_checkpoint" }
      : {
          type: "message",
          id: `msg_${responseId}`,
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        });
  pendingTool = undefined;
  const inputTokens = Math.ceil(input.length / 4);
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

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  let body: Buffer = Buffer.concat(chunks);
  if (request.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
  respond(JSON.parse(body.toString("utf8")) as ObjectValue, response);
}

class Rpc {
  readonly events: RpcMessage[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }
  >();
  private failure: Error | undefined;

  constructor(binary: string, home: string, broken: boolean) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: home,
      PRUNER_PROVIDER: "heuristic",
    };
    delete env["CODEX_CONTEXT_PRUNER_COMMAND"];
    if (broken)
      env["CODEX_CONTEXT_PRUNER_COMMAND"] = JSON.stringify([
        process.execPath,
        "-e",
        "process.exit(7)",
      ]);
    const command = broken ? binary : process.execPath;
    const args = broken ? ["app-server", "--stdio"] : [launcher, binary, "app-server", "--stdio"];
    this.child = spawn(command, args, {
      cwd: home,
      env,
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on("data", () => {});
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`app-server exited (${code})`)));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
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
        else pending.resolve(message["result"] as ObjectValue);
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
      const event = this.events.slice(after).find((event) => event.method === method);
      if (event) return event;
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  async initialize(): Promise<void> {
    await this.call("initialize", {
      clientInfo: { name: "pruner_smoke", version: "0.1.0" },
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

function configure(home: string, baseUrl: string, route: Route, auto: boolean): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-6.1-sol"',
      'model_provider = "smoke"',
      "model_context_window = 128000",
      `model_auto_compact_token_limit = ${auto ? 20000 : 1000000}`,
      'model_auto_compact_token_limit_scope = "total"',
      'compact_prompt = "SUMMARIZE_SMOKE_HISTORY"',
      "model_post_turn_compact_threshold_percent = 0",
      "[features]",
      "code_mode = true",
      "apps = false",
      "enable_request_compression = false",
      "[features.code_mode_host]",
      "enabled = true",
      "disable_in_process_fallback = true",
      "[model_providers.smoke]",
      'name = "Synthetic smoke provider"',
      `base_url = ${JSON.stringify(baseUrl)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "[model_providers.smoke.capabilities]",
      `remote_compaction = "${route}"`,
    ].join("\n"),
  );
}

function oldToolPair(index: number): ObjectValue[] {
  const call_id = `old_call_${index}`;
  const output = "OLD_RESULT_TO_REMOVE_".repeat(500);
  return index % 2 === 0
    ? [
        { type: "function_call", name: "exec_command", call_id, arguments: '{"cmd":"old probe"}' },
        { type: "function_call_output", call_id, output },
      ]
    : [
        { type: "custom_tool_call", name: "exec", call_id, input: "text('old probe');" },
        {
          type: "custom_tool_call_output",
          call_id,
          output: [
            { type: "input_text", text: "Script completed" },
            { type: "input_text", text: output },
          ],
        },
      ];
}

function fixture(): ObjectValue[] {
  const items: ObjectValue[] = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "USER_GOAL_MUST_SURVIVE" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ASSISTANT_PLAN_MUST_SURVIVE" }],
    },
  ];
  for (let i = 0; i < 20; i++) {
    items.push(...oldToolPair(i));
  }
  items.push(
    ...Array.from({ length: 170 }, (_, i) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `preserved marker ${i}` }],
    })),
  );
  items.push(
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "recent_call",
      input: "text('recent probe');",
    },
    {
      type: "custom_tool_call_output",
      call_id: "recent_call",
      output: [{ type: "input_text", text: "RECENT_RESULT_MUST_SURVIVE" }],
    },
  );
  return items;
}

async function turn(rpc: Rpc, threadId: string, text: string): Promise<void> {
  const after = rpc.events.length;
  await rpc.call("turn/start", { threadId, input: [{ type: "text", text }] });
  const done = await rpc.wait("turn/completed", after);
  const result = done.params?.["turn"] as ObjectValue;
  assert.equal(result["status"], "completed", JSON.stringify(result["error"]));
}

function assertPruned(request: ObjectValue): void {
  const input = JSON.stringify(request["input"]);
  assert(!input.includes("OLD_RESULT_TO_REMOVE_"), "Old output reached the next model request");
  for (const text of [
    "USER_GOAL_MUST_SURVIVE",
    "ASSISTANT_PLAN_MUST_SURVIVE",
    "RECENT_RESULT_MUST_SURVIVE",
  ]) {
    assert(input.includes(text), `Protected text disappeared: ${text}`);
  }
  assert(input.includes("agent-context-pruner removed tool call"));
}

function assertFallback(route: Route, first: ObjectValue, next: ObjectValue): void {
  const initial = JSON.stringify(first["input"]);
  assert(
    initial.includes(route === "v2" ? '"type":"compaction_trigger"' : "SUMMARIZE_SMOKE_HISTORY"),
    "Fallback used an unexpected compaction route",
  );
  const input = JSON.stringify(next["input"]);
  assert(
    input.includes(route === "v2" ? "mock_checkpoint" : "SMOKE_SUMMARY"),
    "The native fallback checkpoint did not survive",
  );
  assert(!input.includes("OLD_RESULT_TO_REMOVE_"), "Native fallback did not replace old history");
}

async function startFixture(rpc: Rpc, home: string, auto: boolean): Promise<string> {
  await rpc.initialize();
  const started = await rpc.call("thread/start", {
    cwd: home,
    baseInstructions: "You are a smoke test assistant.",
    approvalPolicy: "never",
    sandbox: "read-only",
    experimentalRawEvents: true,
  });
  const id = (started["thread"] as ObjectValue)["id"] as string;
  await rpc.call("thread/inject_items", { threadId: id, items: fixture() });
  // Injected assistant items are not metered until a sampling response reports their usage.
  if (auto) await turn(rpc, id, "Establish usage for the synthetic history.");
  return id;
}

async function compactAndContinue(
  rpc: Rpc,
  id: string,
  before: number,
  route: Route,
  auto: boolean,
  broken: boolean,
): Promise<number> {
  const at = Date.now();
  if (!auto) {
    const after = rpc.events.length;
    await rpc.call("thread/compact/start", { threadId: id });
    await rpc.wait("turn/completed", after);
    assert.equal(requests.length - before, broken ? 1 : 0, "Unexpected summarizer request count");
  }
  await turn(rpc, id, "Continue the smoke test.");
  assert.equal(requests.length - before, broken ? 2 : 1, "Unexpected model request count");
  if (broken) assertFallback(route, requests[before]!, requests.at(-1)!);
  else assertPruned(requests.at(-1)!);
  return Date.now() - at;
}

async function resumeAndAssert(
  binary: string,
  home: string,
  id: string,
  before: number,
  route: Route,
  broken: boolean,
): Promise<void> {
  const rpc = new Rpc(binary, home, broken);
  try {
    await rpc.initialize();
    await rpc.call("thread/resume", { threadId: id });
    await turn(rpc, id, "Continue after restarting the app server.");
    if (broken) assertFallback(route, requests[before]!, requests.at(-1)!);
    else assertPruned(requests.at(-1)!);
  } finally {
    await rpc.close();
  }
}

async function scenario(
  binary: string,
  baseUrl: string,
  root: string,
  route: Route,
  auto: boolean,
  broken: boolean,
): Promise<ObjectValue> {
  const name = `${route}-${auto ? "auto" : "manual"}-${broken ? "fallback" : "prune"}`;
  const home = join(root, name);
  configure(home, baseUrl, route, auto);
  const rpc = new Rpc(binary, home, broken);
  let before = requests.length;
  let elapsed: number;
  try {
    const id = await startFixture(rpc, home, auto);
    before = requests.length;
    elapsed = await compactAndContinue(rpc, id, before, route, auto, broken);
    await rpc.close();
    await resumeAndAssert(binary, home, id, before, route, broken);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : "Runtime check failed"}`);
  } finally {
    await rpc.close();
  }
  return {
    scenario: name,
    passed: true,
    viaLauncher: !broken,
    primingRequests: auto ? 1 : 0,
    ms: elapsed,
    modelRequests: requests.length - before,
  };
}

function toolOutputTexts(request: ObjectValue, callId: string): string[] {
  const items = request["input"] as ObjectValue[];
  return items
    .filter((item) => item["type"] === "custom_tool_call_output" && item["call_id"] === callId)
    .flatMap((item) =>
      typeof item["output"] === "string"
        ? [item["output"]]
        : (item["output"] as ObjectValue[]).flatMap((block) =>
            typeof block["text"] === "string" ? [block["text"]] : [],
          ),
    );
}

function runtimeToolCall(): ObjectValue {
  return {
    type: "custom_tool_call",
    id: "ctc_runtime_probe",
    call_id: "runtime_probe",
    name: "exec",
    input: [
      '// @exec: {"max_output_tokens":20000}',
      'if (!ALL_TOOLS.some(t => t.name.endsWith("exec_command"))) throw new Error("Tool discovery failed");',
      'const result = await tools.exec_command({cmd:"cat pruner-smoke-input.txt",login:false,max_output_tokens:20000,yield_time_ms:10000});',
      'if (result.exit_code !== 0 || !result.output.startsWith("CODEX_COMMAND_OK")) throw new Error("Local file read failed");',
      'text("CODEX_EXEC_PIPELINE_OK");',
      "text(result.output);",
    ].join("\n"),
  };
}

async function toolScenario(binary: string, baseUrl: string, root: string): Promise<ObjectValue> {
  const home = join(root, "code-mode-tool-execution");
  configure(home, baseUrl, "unsupported", false);
  writeFileSync(
    join(home, "pruner-smoke-input.txt"),
    `CODEX_COMMAND_OK\n${"REAL_OLD_RESULT_".repeat(4000)}\n`,
  );
  const rpc = new Rpc(binary, home, false);
  const before = requests.length;
  try {
    await rpc.initialize();
    const started = await rpc.call("thread/start", {
      cwd: home,
      baseInstructions: "You are a synthetic tool test.",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const id = (started["thread"] as ObjectValue)["id"] as string;
    pendingTool = runtimeToolCall();
    await turn(rpc, id, "Execute the runtime tool probe.");
    assert.equal(requests.length - before, 2, "The model did not receive a tool result");
    const output = toolOutputTexts(requests.at(-1)!, "runtime_probe");
    assert(
      output.some((text) => text.split(/\r?\n/).includes("CODEX_EXEC_PIPELINE_OK")),
      `Code-mode tool execution failed: ${JSON.stringify(output).slice(0, 1200)}`,
    );
    assert(
      output.some((text) => text.includes("REAL_OLD_RESULT_")),
      "Large tool output is missing",
    );
    await pruneRealToolOutput(rpc, id);
  } finally {
    pendingTool = undefined;
    await rpc.close();
  }
  return {
    scenario: "code-mode-tool-execution",
    passed: true,
    viaLauncher: true,
    prunedRealCodeModeOutput: true,
    modelRequests: requests.length - before,
  };
}

async function pruneRealToolOutput(rpc: Rpc, id: string): Promise<void> {
  await rpc.call("thread/inject_items", {
    threadId: id,
    items: Array.from({ length: 170 }, (_, i) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `Retain this later marker ${i}` }],
    })),
  });
  const before = requests.length;
  const after = rpc.events.length;
  await rpc.call("thread/compact/start", { threadId: id });
  await rpc.wait("turn/completed", after);
  assert.equal(requests.length, before, "Real code-mode output used the native summarizer");
  await turn(rpc, id, "Continue after pruning the real tool result.");
  const input = JSON.stringify(requests.at(-1)!["input"]);
  assert(!input.includes("REAL_OLD_RESULT_"), "Real code-mode output was not removed");
  assert(input.includes("Execute the runtime tool probe."), "The user's goal disappeared");
  assert(input.includes("agent-context-pruner removed tool call"), "Pruning note is missing");
}

async function main(): Promise<void> {
  const binary = process.argv[2];
  assert(binary && isAbsolute(binary), "Pass the absolute path to the patched Codex executable.");
  const root = mkdtempSync(join(tmpdir(), "context-pruner-smoke-"));
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.writeHead(500).end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const results: ObjectValue[] = [];
  try {
    results.push(await toolScenario(binary, baseUrl, root));
    for (const route of ["unsupported", "v2"] as const) {
      results.push(await scenario(binary, baseUrl, root, route, false, false));
      results.push(await scenario(binary, baseUrl, root, route, true, false));
      results.push(await scenario(binary, baseUrl, root, route, false, true));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const report = { synthetic: true, binary, results };
  writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ...report, report: join(root, "report.json") }, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime smoke test failed"}\n`);
  process.exitCode = 1;
});
