import { truncatedResultText, type Message, type ToolUse } from "@9tech.solutions/pruner-domain";
import { createHeuristicModel } from "@9tech.solutions/pruner-models";
import { planPruning, type PruneEdit } from "./plan.ts";

type RawItem = Record<string, unknown>;
type ToolKind = "function" | "custom";

interface PairSeed {
  readonly callIndex: number;
  readonly resultIndex: number;
  readonly callId: string;
  readonly kind: ToolKind;
}

interface PrunePair extends PairSeed {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly text: string;
  readonly arrayOutput: boolean;
}

interface TextOutput {
  readonly text: string;
  readonly array: boolean;
}

interface PruneResult {
  readonly body: unknown;
  readonly removedCharacters: number;
  readonly editedResults: number;
}

const MAX_ITEMS = 20_000;
const PROTECTED_HEAD_ITEMS = 6;
const CALL_KIND: Readonly<Record<string, ToolKind>> = {
  function_call: "function",
  custom_tool_call: "custom",
};
const OUTPUT_KIND: Readonly<Record<string, ToolKind>> = {
  function_call_output: "function",
  custom_tool_call_output: "custom",
};

function isRecord(value: unknown): value is RawItem {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unchanged(body: unknown): PruneResult {
  return { body, removedCharacters: 0, editedResults: 0 };
}

function inputItems(body: unknown): RawItem[] | null {
  if (!isRecord(body) || Object.hasOwn(body, "previous_response_id")) return null;
  const input = body["input"];
  if (!Array.isArray(input) || input.length > MAX_ITEMS) return null;
  for (const item of input) if (!isRecord(item)) return null;
  const items = input as RawItem[];
  return items.some((item) => item["type"] === "compaction_trigger") ? null : items;
}

function toolKind(type: unknown, kinds: Readonly<Record<string, ToolKind>>): ToolKind | undefined {
  return typeof type === "string" && Object.hasOwn(kinds, type) ? kinds[type] : undefined;
}

function pairSeeds(items: readonly RawItem[]): PairSeed[] | null {
  const occurrences = new Map<string, number[]>();
  const calls = new Map<number, { readonly callId: string; readonly kind: ToolKind }>();
  const outputs = new Map<number, { readonly callId: string; readonly kind: ToolKind }>();
  for (const [index, item] of items.entries()) {
    const type = item["type"];
    const callKind = toolKind(type, CALL_KIND);
    const outputKind = toolKind(type, OUTPUT_KIND);
    const kind = callKind ?? outputKind;
    const callId = item["call_id"];
    if (kind && (typeof callId !== "string" || callId.length === 0)) return null;
    if (typeof callId === "string") {
      const indices = occurrences.get(callId);
      if (indices) indices.push(index);
      else occurrences.set(callId, [index]);
    }
    if (!kind) continue;
    const slot = callKind ? calls : outputs;
    slot.set(index, { callId: callId as string, kind });
  }

  const seeds: PairSeed[] = [];
  for (const [callIndex, call] of calls) {
    const indices = occurrences.get(call.callId);
    const resultIndex = indices?.[1];
    const output = resultIndex === undefined ? undefined : outputs.get(resultIndex);
    if (
      indices?.length !== 2 ||
      indices[0] !== callIndex ||
      resultIndex === undefined ||
      !output ||
      output.callId !== call.callId ||
      output.kind !== call.kind
    )
      return null;
    seeds.push({ callIndex, resultIndex, callId: call.callId, kind: call.kind });
  }
  return outputs.size === calls.size ? seeds : null;
}

function failedOrIncomplete(item: RawItem): boolean {
  const status = item["status"];
  return (
    (status !== undefined && status !== "completed") ||
    item["success"] === false ||
    item["is_error"] === true ||
    item["isError"] === true ||
    (item["error"] !== undefined && item["error"] !== null)
  );
}

function failedOutputText(text: string): boolean {
  if (/\bscript failed\b/i.test(text)) return true;
  const codes =
    /\b(?:(?:process|command)\s+)?(?:exited?\s+with\s+code|exit\s+code)\s*[:=]?\s*(-?\d+)\b/gi;
  for (const match of text.matchAll(codes)) if (Number(match[1]) !== 0) return true;
  return false;
}

function encrypted(item: RawItem): boolean {
  return ["encrypted_content", "encrypted_function_args"].some(
    (key) => item[key] !== undefined && item[key] !== null,
  );
}

function outputText(value: unknown): TextOutput | null {
  if (typeof value === "string") return { text: value, array: false };
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const part of value) {
    if (
      !isRecord(part) ||
      Object.keys(part).length !== 2 ||
      part["type"] !== "input_text" ||
      typeof part["text"] !== "string"
    )
      return null;
    texts.push(part["text"]);
  }
  return { text: texts.join("\n"), array: true };
}

function callInput(item: RawItem, kind: ToolKind): Record<string, unknown> | null {
  if (kind === "custom") {
    return typeof item["input"] === "string" ? { input: item["input"] } : null;
  }
  if (typeof item["arguments"] !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(item["arguments"]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function prunePairs(items: readonly RawItem[], seeds: readonly PairSeed[]): PrunePair[] {
  const pairs: PrunePair[] = [];
  for (const seed of seeds) {
    if (seed.callIndex < PROTECTED_HEAD_ITEMS || seed.resultIndex < PROTECTED_HEAD_ITEMS) continue;
    const call = items[seed.callIndex];
    const result = items[seed.resultIndex];
    if (
      !call ||
      !result ||
      failedOrIncomplete(call) ||
      failedOrIncomplete(result) ||
      encrypted(call) ||
      encrypted(result)
    )
      continue;
    const tool = call["name"];
    const text = outputText(result["output"]);
    const input = callInput(call, seed.kind);
    if (typeof tool !== "string" || !tool || !text || failedOutputText(text.text) || !input)
      continue;
    pairs.push({ ...seed, tool, input, text: text.text, arrayOutput: text.array });
  }
  return pairs;
}

function messageText(item: RawItem): string {
  if (item["type"] !== "message") return "";
  const content = item["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is RawItem => isRecord(part))
    .filter((part) => part["type"] === "input_text" || part["type"] === "output_text")
    .map((part) => part["text"])
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function domainMessages(items: readonly RawItem[], pairs: readonly PrunePair[]): Message[] {
  const calls = new Map(pairs.map((pair) => [pair.callIndex, pair] as const));
  const results = new Map(pairs.map((pair) => [pair.resultIndex, pair] as const));
  return items.map((item, index) => {
    const call = calls.get(index);
    if (call) {
      const toolUse: ToolUse = {
        tool_use_id: call.callId,
        tool: call.tool,
        input: call.input,
      };
      return { role: "assistant", text: "", toolUses: [toolUse] };
    }
    const result = results.get(index);
    if (result) {
      return {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: result.callId, text: result.text, isError: false }],
      };
    }
    return {
      role: item["role"] === "user" ? "user" : "assistant",
      text: messageText(item),
      toolUses: [],
    };
  });
}

function validatedEdits(
  edits: readonly PruneEdit[],
  pairs: readonly PrunePair[],
): Map<number, string> | null {
  const byCallIndex = new Map(pairs.map((pair) => [pair.callIndex, pair] as const));
  const seen = new Set<number>();
  const validated = new Map<number, string>();
  for (const edit of edits) {
    const pair = byCallIndex.get(edit.callIndex);
    if (
      !pair ||
      pair.resultIndex !== edit.resultIndex ||
      pair.callId !== edit.callId ||
      seen.has(edit.callIndex)
    )
      return null;
    seen.add(edit.callIndex);
    const expected = truncatedResultText(pair.text, false, 300);
    if (!expected.isWellFormed()) return null;
    if (edit.action === "drop_result" && edit.text !== expected) return null;
    if (edit.action === "drop_call" && edit.text !== undefined) return null;
    if (edit.action !== "drop_call" && edit.action !== "drop_result") return null;
    if (expected !== pair.text) validated.set(pair.resultIndex, expected);
  }
  return validated;
}

function applyEdits(
  body: RawItem,
  items: readonly RawItem[],
  pairs: readonly PrunePair[],
  edits: ReadonlyMap<number, string>,
): PruneResult {
  const byResultIndex = new Map(pairs.map((pair) => [pair.resultIndex, pair] as const));
  let removedCharacters = 0;
  let editedResults = 0;
  const input = items.map((item, index) => {
    const text = edits.get(index);
    const pair = byResultIndex.get(index);
    if (text === undefined || !pair) return item;
    removedCharacters += pair.text.length - text.length;
    editedResults++;
    return { ...item, output: pair.arrayOutput ? [{ type: "input_text", text }] : text };
  });
  return editedResults === 0
    ? unchanged(body)
    : { body: { ...body, input }, removedCharacters, editedResults };
}

/** Prune only validated old text results; every fail-open path returns the input body itself. */
export async function pruneRequest(body: unknown): Promise<PruneResult> {
  try {
    const items = inputItems(body);
    if (!items || !isRecord(body)) return unchanged(body);
    const seeds = pairSeeds(items);
    if (!seeds) return unchanged(body);
    const pairs = prunePairs(items, seeds);
    if (pairs.length === 0) return unchanged(body);
    const plan = await planPruning(domainMessages(items, pairs), createHeuristicModel());
    if (!plan.ok) return unchanged(body);
    const edits = validatedEdits(plan.value.edits, pairs);
    return edits ? applyEdits(body, items, pairs, edits) : unchanged(body);
  } catch {
    return unchanged(body);
  }
}
