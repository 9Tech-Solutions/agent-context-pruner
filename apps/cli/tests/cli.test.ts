import type { HttpTransport } from "@9tech.solutions/pruner-models";
import { describe, expect, it } from "vite-plus/test";
import { parseEvalArgs } from "../src/args.ts";
import { runEval, type Io } from "../src/run-eval.ts";
import { parseClaudeTranscript } from "../src/transcript.ts";

const row = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content }, ...extra });

const read = (n: number) => [
  row("assistant", [
    { type: "thinking", thinking: "" },
    { type: "tool_use", id: `r${n}`, name: "Read", input: { file_path: `src/file${n}.ts` } },
  ]),
  row("user", [
    {
      type: "tool_result",
      tool_use_id: `r${n}`,
      content: [
        { type: "text", text: `1\texport const valueNumber${n} = computeSomething(${n});` },
      ],
    },
  ]),
];

/** Twelve reads, a prompt, then an edit reusing file3's line; a sidechain row; a compaction. */
function sessionFile(): string {
  const reads = Array.from({ length: 12 }, (_, i) => read(i + 1)).flat();
  return [
    row("user", "Refactor the value modules."),
    ...reads,
    row("user", "now update file3"),
    row("assistant", [
      {
        type: "tool_use",
        id: "e1",
        name: "Edit",
        input: {
          file_path: "src/file3.ts",
          old_string: "export const valueNumber3 = computeSomething(3);",
        },
      },
    ]),
    row("user", [{ type: "tool_result", tool_use_id: "e1", content: "updated" }]),
    row("assistant", "subagent row", { isSidechain: true }),
    "not json",
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    row("user", "after the compaction"),
  ].join("\n");
}

function io(
  files: Record<string, string>,
  overrides: Partial<Io> = {},
): Io & { output: string[]; notes: string[]; written: Record<string, string> } {
  const output: string[] = [];
  const notes: string[] = [];
  const written: Record<string, string> = {};
  const transport: HttpTransport = async () => {
    throw new Error("no network in tests");
  };
  return {
    output,
    notes,
    written,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async (path, text) => {
      written[path] = text;
    },
    out: (text) => output.push(text),
    progress: (text) => notes.push(text),
    env: {},
    transport,
    ...overrides,
  };
}

describe("parseClaudeTranscript", () => {
  it("keeps main-thread rows, drops thinking and bad lines, and splits at compactions", () => {
    const parsed = parseClaudeTranscript(sessionFile());
    expect(parsed.badLines).toBe(1);
    expect(parsed.segments.map((s) => s.length)).toEqual([28, 1]);
    const first = parsed.segments[0]!;
    expect(first[1]).toEqual({
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "src/file1.ts" } }],
      toolResults: [],
    });
    expect(first[2]!.toolResults![0]!.text).toContain("valueNumber1");
    expect(first.some((m) => m.text === "subagent row")).toBe(false);
  });
});

describe("parseEvalArgs", () => {
  it("reads providers and numbers, and rejects what it cannot use", () => {
    const args = parseEvalArgs(["a.jsonl", "--provider", "heuristic,typesafe", "--cuts", "2"]);
    expect(args.ok && args.value).toMatchObject({
      files: ["a.jsonl"],
      providers: ["heuristic", "typesafe"],
      cuts: 2,
      maxLoss: 1,
    });
    expect(parseEvalArgs([])).toMatchObject({ ok: false });
    expect(parseEvalArgs(["a.jsonl", "--provider", "gpt"])).toMatchObject({
      ok: false,
      error: "unknown provider: gpt",
    });
    expect(parseEvalArgs(["a.jsonl", "--cuts", "many"])).toMatchObject({ ok: false });
    expect(parseEvalArgs(["a.jsonl", "--head="])).toMatchObject({
      ok: false,
      error: "--head needs a value",
    });
    expect(parseEvalArgs(["a.jsonl", "--provider", ","])).toMatchObject({ ok: false });
  });

  it("refuses one --model or --base-url for two network providers", () => {
    const both = [
      "a.jsonl",
      "--provider",
      "typesafe,ollama",
      "--base-url",
      "http://localhost:11434",
    ];
    expect(parseEvalArgs(both)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/one provider/),
    });
    const one = [
      "a.jsonl",
      "--provider",
      "heuristic,ollama",
      "--base-url",
      "http://localhost:11434",
    ];
    expect(parseEvalArgs(one).ok).toBe(true);
  });
});

describe("runEval", () => {
  it("reports the rules-based model and writes JSON without transcript text", async () => {
    const files = { "s.jsonl": sessionFile() };
    const args = parseEvalArgs(["s.jsonl", "--json", "out.json", "--preserve", "2"]);
    if (!args.ok) throw new Error(args.error);
    const run = io(files);
    expect(await runEval(args.value, run)).toBe(0);
    expect(run.output.join("")).toMatch(/^heuristic:v1: 1 compaction points, 11 scored calls/);
    expect(run.notes.some((n) => n.includes("sending"))).toBe(false);
    const json = run.written["out.json"]!;
    expect(JSON.parse(json)[0].neededShare).toBeCloseTo(1 / 11);
    expect(json).not.toContain("valueNumber");
  });

  it("names the provider before sending, and reports a model that cannot be built", async () => {
    const args = parseEvalArgs(["s.jsonl", "--provider", "typesafe", "--preserve", "2"]);
    if (!args.ok) throw new Error(args.error);
    const run = io({ "s.jsonl": sessionFile() });
    expect(await runEval(args.value, run)).toBe(1);
    expect(run.notes.at(-1)).toMatch(/typesafe: .*API key/);
  });

  it("fails, without a recommendation or the provider's reply in the report, when no point can be scored", async () => {
    const args = parseEvalArgs([
      "s.jsonl",
      "--provider",
      "typesafe",
      "--preserve",
      "2",
      "--json",
      "out.json",
    ]);
    if (!args.ok) throw new Error(args.error);
    const run = io(
      { "s.jsonl": sessionFile() },
      {
        env: { TYPESAFE_API_KEY: "k" },
        transport: async () => ({
          status: 422,
          ok: false,
          text: '{"detail":"bad state valueNumber3"}',
        }),
      },
    );
    expect(await runEval(args.value, run)).toBe(1);
    expect(run.output.join("")).toMatch(/no compaction point could be scored/);
    expect(run.written["out.json"]).not.toContain("valueNumber");
    expect(JSON.parse(run.written["out.json"]!)[0].recommended).toBeNull();
  });

  it("returns an exit code when the JSON report cannot be written", async () => {
    const args = parseEvalArgs(["s.jsonl", "--preserve", "2", "--json", "missing/out.json"]);
    if (!args.ok) throw new Error(args.error);
    const run = io(
      { "s.jsonl": sessionFile() },
      {
        writeFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(await runEval(args.value, run)).toBe(1);
    expect(run.notes.at(-1)).toBe("cannot write missing/out.json: ENOENT");
  });

  it("says when lines are not JSON", async () => {
    const args = parseEvalArgs(["s.jsonl", "--preserve", "2"]);
    if (!args.ok) throw new Error(args.error);
    const run = io({ "s.jsonl": sessionFile() });
    await runEval(args.value, run);
    expect(run.notes[0]).toBe("s.jsonl: skipped 1 lines that are not JSON");
  });

  it("fails clearly on a missing file", async () => {
    const args = parseEvalArgs(["missing.jsonl"]);
    if (!args.ok) throw new Error(args.error);
    const run = io({});
    expect(await runEval(args.value, run)).toBe(1);
    expect(run.notes[0]).toMatch(/cannot read missing\.jsonl: ENOENT/);
  });
});
