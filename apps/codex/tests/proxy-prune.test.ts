import { describe, expect, it } from "vite-plus/test";
import { pruneRequest } from "../src/proxy-prune.ts";

type Item = Record<string, unknown>;

function message(role: string, text: string): Item {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  };
}

function functionCall(callId: string, overrides: Item = {}): Item {
  return {
    type: "function_call",
    call_id: callId,
    name: "exec_command",
    arguments: '{"cmd":"old probe"}',
    ...overrides,
  };
}

function functionOutput(callId: string, output: unknown, overrides: Item = {}): Item {
  return { type: "function_call_output", call_id: callId, output, ...overrides };
}

function agedInput(...items: Item[]): Item[] {
  return agedInputWithLater(90, ...items);
}

function agedInputWithLater(laterCount: number, ...items: Item[]): Item[] {
  return [
    message("user", "keep this request"),
    ...Array.from({ length: 5 }, (_, index) => message("assistant", `intro ${index}`)),
    ...items,
    ...Array.from({ length: laterCount }, (_, index) => message("assistant", `later ${index}`)),
  ];
}

function body(input: unknown): Item {
  return { model: "gpt-6.1-sol", input };
}

describe("Codex Responses request pruning", () => {
  it("truncates an old large text result and leaves its call and all other items intact", async () => {
    const output = "old result ".repeat(100);
    const call = functionCall("old");
    const result = functionOutput("old", output, { id: "output_1", status: "completed" });
    const unknown = { type: "reasoning", encrypted_content: "opaque", summary: [] };
    const input = agedInput(call, result, unknown);
    const request = body(input);

    const pruned = await pruneRequest(request);
    const expected = `${output.slice(0, 300)}\n[agent-context-pruner truncated ${output.length - 300} chars of this tool result; re-run the tool if needed]`;

    expect(pruned.editedResults).toBe(1);
    expect(pruned.removedCharacters).toBe(output.length - expected.length);
    expect((pruned.body as Item)["input"]).not.toBe(input);
    const changed = (pruned.body as Item)["input"] as Item[];
    expect(changed.slice(0, 6)).toEqual(input.slice(0, 6));
    expect(changed[6]).toBe(call);
    expect(changed[7]).toEqual({ ...result, output: expected });
    expect(changed[8]).toBe(unknown);
    expect(changed.slice(8)).toEqual(input.slice(8));
  });

  it("retains call/result pairing and truncates results when an old call decision is drop_call", async () => {
    const output = "very old result ".repeat(100);
    const call = functionCall("ancient");
    const result = functionOutput("ancient", output);
    const input = agedInputWithLater(170, call, result);
    const request = body(input);

    const pruned = await pruneRequest(request);
    const expected = `${output.slice(0, 300)}\n[agent-context-pruner truncated ${output.length - 300} chars of this tool result; re-run the tool if needed]`;
    const changed = (pruned.body as Item)["input"] as Item[];

    expect(pruned.editedResults).toBe(1);
    expect(changed[6]).toBe(call);
    expect(changed[7]).toEqual({ ...result, output: expected });
  });

  it("keeps recent results through the domain's recent-message pinning", async () => {
    const output = "recent result ".repeat(100);
    const input = [
      message("user", "keep this request"),
      ...Array.from({ length: 90 }, (_, index) => message("assistant", `older ${index}`)),
      functionCall("recent"),
      functionOutput("recent", output),
    ];
    const request = body(input);
    const firstSixRequest = body([
      message("user", "keep this request"),
      functionCall("first-six"),
      functionOutput("first-six", output),
      message("assistant", "intro 1"),
      message("assistant", "intro 2"),
      message("assistant", "intro 3"),
      ...Array.from({ length: 90 }, (_, index) => message("assistant", `later ${index}`)),
    ]);

    const pruned = await pruneRequest(request);
    const firstSix = await pruneRequest(firstSixRequest);

    expect(pruned).toEqual({ body: request, removedCharacters: 0, editedResults: 0 });
    expect(firstSix).toEqual({ body: firstSixRequest, removedCharacters: 0, editedResults: 0 });
  });

  it("preserves messages, failed results, encrypted items, and media results", async () => {
    const failedCall = functionCall("failed");
    const failed = functionOutput("failed", "failure details", {
      status: "failed",
      is_error: true,
    });
    const encryptedCall = functionCall("encrypted");
    const encrypted = functionOutput("encrypted", "encrypted result ".repeat(100), {
      encrypted_content: "opaque",
    });
    const mediaCall = {
      type: "custom_tool_call",
      call_id: "media",
      name: "render",
      input: "render image",
    };
    const media = {
      type: "custom_tool_call_output",
      call_id: "media",
      output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    };
    const roles = [
      message("system", "system policy"),
      message("developer", "developer policy"),
      message("assistant", "assistant note"),
    ];
    const input = agedInput(
      functionCall("old"),
      functionOutput("old", "old result ".repeat(100)),
      failedCall,
      failed,
      mediaCall,
      media,
      encryptedCall,
      encrypted,
      ...roles,
    );
    const request = body(input);

    const pruned = await pruneRequest(request);
    const changed = (pruned.body as Item)["input"] as Item[];

    expect(changed[0]).toBe(input[0]);
    expect(changed[0]).toBe(input[0]);
    expect(changed[8]).toBe(failedCall);
    expect(changed[9]).toBe(failed);
    expect(changed[10]).toBe(mediaCall);
    expect(changed[11]).toBe(media);
    expect(changed[12]).toBe(encryptedCall);
    expect(changed[13]).toBe(encrypted);
    expect(changed.slice(14, 17)).toEqual(roles);
    expect(changed[6]).toBe(input[6]);
  });

  it("allows ordinary logs that mention errors and a successful zero exit code", async () => {
    const output = `The log documents an error code. Process exited with code 0\n${"normal output ".repeat(100)}`;
    const input = agedInput(functionCall("success"), functionOutput("success", output));
    const request = body(input);

    const pruned = await pruneRequest(request);
    const changed = (pruned.body as Item)["input"] as Item[];
    const expected = `${output.slice(0, 300)}\n[agent-context-pruner truncated ${output.length - 300} chars of this tool result; re-run the tool if needed]`;

    expect(pruned.editedResults).toBe(1);
    expect(changed[7]).toEqual({ ...input[7], output: expected });
  });

  it("preserves success:false results and textual command failures despite completed status", async () => {
    const cases = [
      [
        functionCall("explicit-failure"),
        functionOutput("explicit-failure", "explicitly failed output ".repeat(100), {
          status: "completed",
          success: false,
        }),
      ],
      [
        functionCall("process-failure"),
        functionOutput(
          "process-failure",
          `Process exited with code 1\n${"failed process output ".repeat(100)}`,
          { status: "completed" },
        ),
      ],
      [
        {
          type: "custom_tool_call",
          call_id: "script-failure",
          name: "exec",
          input: "text(await tools.exec_command({cmd:'probe'}));",
        },
        {
          type: "custom_tool_call_output",
          call_id: "script-failure",
          output: [
            { type: "input_text", text: "Script failed" },
            { type: "input_text", text: "exit code: 1" },
            { type: "input_text", text: "failed script output ".repeat(100) },
          ],
        },
      ],
    ].flat();
    const input = agedInput(...cases);
    const request = body(input);

    expect(await pruneRequest(request)).toEqual({
      body: request,
      removedCharacters: 0,
      editedResults: 0,
    });
  });

  it("keeps text-array results as arrays and preserves result metadata", async () => {
    const output = "array result ".repeat(100);
    const originalText = `Script completed\n${output}`;
    const input = agedInput(
      {
        type: "custom_tool_call",
        call_id: "custom",
        name: "exec",
        input: "text('old probe');",
      },
      {
        type: "custom_tool_call_output",
        call_id: "custom",
        id: "output_custom",
        status: "completed",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_text", text: output },
        ],
      },
    );
    const request = body(input);

    const pruned = await pruneRequest(request);
    const changed = (pruned.body as Item)["input"] as Item[];
    const expected = `${originalText.slice(0, 300)}\n[agent-context-pruner truncated ${originalText.length - 300} chars of this tool result; re-run the tool if needed]`;

    expect(changed[7]).toEqual({
      ...input[7],
      output: [{ type: "input_text", text: expected }],
    });
    expect(Array.isArray((changed[7] as Item)["output"])).toBe(true);
  });

  it("fails open on duplicate, orphaned, mismatched, or malformed tool pairs", async () => {
    const call = functionCall("ambiguous");
    const result = functionOutput("ambiguous", "old result ".repeat(100));
    const cases = [
      agedInput(call, result, functionCall("ambiguous")),
      agedInput(call, result, { type: "future_tool", call_id: "ambiguous" }),
      agedInput(functionOutput("orphan", "old result ".repeat(100))),
      agedInput(functionCall("orphan")),
      agedInput(call, { ...result, type: "custom_tool_call_output" }),
      agedInput(
        functionCall("bad", { arguments: "{" }),
        functionOutput("bad", "old result ".repeat(100)),
      ),
    ];

    for (const input of cases) {
      const request = body(input);
      expect(await pruneRequest(request)).toEqual({
        body: request,
        removedCharacters: 0,
        editedResults: 0,
      });
    }
  });

  it("passes through prior-response, compaction, non-array, and oversized inputs", async () => {
    const oldPair = [functionCall("old"), functionOutput("old", "old result ".repeat(100))];
    const prior = { ...body(agedInput(...oldPair)), previous_response_id: null };
    const compaction = body([...agedInput(...oldPair), { type: "compaction_trigger" }]);
    const nonArray = body("a prior prompt");
    const malformed = body([null]);
    const oversized = body(Array.from({ length: 20_001 }, () => message("assistant", "x")));

    for (const request of [prior, compaction, nonArray, malformed, oversized]) {
      expect(await pruneRequest(request)).toEqual({
        body: request,
        removedCharacters: 0,
        editedResults: 0,
      });
    }
  });
});
