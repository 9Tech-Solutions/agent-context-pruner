import { callPath, type Message, type ToolCall } from "@9tech.solutions/pruner-domain";
import { authoredText, fragmentsOf, inputStrings } from "./fragments.ts";

/**
 * What the rest of the session shows about one tool call, after the
 * compaction point. "Needed" marks the call holding the most recent copy of
 * text the model wrote again later: older copies are safe to drop while it stays.
 */
export interface HindsightLabel {
  /** The result holds the most recent copy of text the model reused. */
  readonly resultNeeded: boolean;
  /** Where in the result the last such text ends; 0 when none. */
  readonly neededUntil: number;
  /** The input holds the most recent copy (a Write's content, an Edit's new lines). */
  readonly inputNeeded: boolean;
  /** The result or input was needed, or the model later named the call's file or URL. */
  readonly callNeeded: boolean;
}

/** One call before the cut that holds a reused fragment. */
export interface Holder {
  readonly callId: string;
  /** In the call's result; otherwise in its input. */
  readonly inResult: boolean;
  /** For a result, where the fragment's first copy ends; 0 for an input. */
  readonly end: number;
  /** Characters fetching it again costs: the result's size, or the input's. */
  readonly cost: number;
}

/** Text the model wrote after the cut that, before the cut, only droppable calls held. */
export interface NeededFragment {
  readonly text: string;
  /** In message order: the last is the most recent copy. */
  readonly holders: readonly Holder[];
}

export interface CutLabels {
  readonly labels: ReadonlyMap<string, HindsightLabel>;
  readonly needed: readonly NeededFragment[];
}

/**
 * Fragments the model wrote after the cut before anything after the cut (a
 * tool result, a pasted prompt) supplied them again: what it took from the
 * context the compaction would have left.
 */
function usedAfter(future: readonly Message[]): Set<string> {
  const used = new Set<string>();
  const supplied = new Set<string>();
  for (const message of future) {
    for (const f of fragmentsOf(authoredText(message))) if (!supplied.has(f.text)) used.add(f.text);
    if (message.role !== "user") continue;
    const text = [message.text, ...(message.toolResults ?? []).map((r) => r.text)].join("\n");
    for (const f of fragmentsOf(text)) supplied.add(f.text);
  }
  return used;
}

interface Scan {
  /** Fragments held by text compaction never removes: prompts, replies, unpaired calls. */
  readonly permanent: Set<string>;
  readonly holders: Map<string, Holder[]>;
}

function addHolder(scan: Scan, text: string, holder: Holder): void {
  const list = scan.holders.get(text) ?? [];
  const seen = list.some((h) => h.callId === holder.callId && h.inResult === holder.inResult);
  if (!seen) scan.holders.set(text, [...list, holder]);
}

function scanText(scan: Scan, used: ReadonlySet<string>, text: string, holder?: Holder): void {
  for (const fragment of fragmentsOf(text)) {
    if (!used.has(fragment.text)) continue;
    if (!holder) scan.permanent.add(fragment.text);
    else
      addHolder(scan, fragment.text, holder.inResult ? { ...holder, end: fragment.end } : holder);
  }
}

function scanHistory(
  history: readonly Message[],
  calls: readonly ToolCall[],
  used: ReadonlySet<string>,
): Scan {
  const byToolUse = new Map(calls.map((call) => [call.tool_use_id, call] as const));
  const scan: Scan = { permanent: new Set(), holders: new Map() };
  for (const message of history) {
    scanText(scan, used, message.text);
    for (const tool of message.toolUses) {
      const call = byToolUse.get(tool.tool_use_id);
      const text = inputStrings(tool.input);
      const holder = call && { callId: call.id, inResult: false, end: 0, cost: text.length };
      scanText(scan, used, text, holder);
    }
    for (const result of message.toolResults ?? []) {
      const call = byToolUse.get(result.tool_use_id);
      const holder = call && { callId: call.id, inResult: true, end: 0, cost: result.text.length };
      scanText(scan, used, result.text, holder);
    }
  }
  return scan;
}

/** A file path with a file name (not a directory or `.`), lower-cased with forward slashes. */
function fileTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  const path = callPath(input)?.toLowerCase();
  const base = path?.split("/").pop() ?? "";
  return base !== "." && base !== ".." && /\.[a-z0-9]+$/.test(base) ? path : undefined;
}

function namesTarget(call: ToolCall, futureText: string): boolean {
  const url = call.input["url"];
  if (typeof url === "string") return futureText.includes(url.toLowerCase());
  const path = fileTarget(call.input);
  if (!path) return false;
  const base = path.split("/").pop() ?? "";
  return futureText.includes(path) || (base.length >= 6 && futureText.includes(base));
}

function labelsFor(
  calls: readonly ToolCall[],
  needed: readonly NeededFragment[],
  futureText: string,
): Map<string, HindsightLabel> {
  const resultEnd = new Map<string, number>();
  const inputHit = new Set<string>();
  for (const holder of needed.flatMap((fragment) => fragment.holders.slice(-1))) {
    if (!holder.inResult) inputHit.add(holder.callId);
    else resultEnd.set(holder.callId, Math.max(resultEnd.get(holder.callId) ?? 0, holder.end));
  }
  return new Map(
    calls.map((call) => {
      const end = resultEnd.get(call.id);
      const resultNeeded = end !== undefined;
      const inputNeeded = inputHit.has(call.id);
      const callNeeded = resultNeeded || inputNeeded || namesTarget(call, futureText);
      return [call.id, { resultNeeded, neededUntil: end ?? 0, inputNeeded, callNeeded }] as const;
    }),
  );
}

/**
 * Labels the calls of `messages.slice(0, cut)` by what the model did after
 * `cut`. Text it wrote again (an Edit's `old_string`, an id from `git log`)
 * is needed when, before the cut, only droppable calls held it and nothing
 * after the cut supplied it again first. Each such fragment keeps every call
 * holding it, so a sweep can tell when the last copy goes.
 */
export function labelCut(
  messages: readonly Message[],
  cut: number,
  calls: readonly ToolCall[],
): CutLabels {
  const future = messages.slice(cut);
  const scan = scanHistory(messages.slice(0, cut), calls, usedAfter(future));
  const needed = [...scan.holders]
    .filter(([text]) => !scan.permanent.has(text))
    .map(([text, holders]) => ({ text, holders }));
  const futureText = future.map(authoredText).join("\n").replace(/\\/g, "/").toLowerCase();
  return { labels: labelsFor(calls, needed, futureText), needed };
}
