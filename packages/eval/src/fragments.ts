import type { Message } from "@9tech.solutions/pruner-domain";

/** Shorter lines (`}`, `return x;`) are too common to show that a result was used. */
export const MIN_LINE_CHARS = 24;
/** Shorter words are too common to show that a result was used. */
export const MIN_TOKEN_CHARS = 12;

/** A piece of text that can show a result was used later, and where it ends in that text. */
export interface Fragment {
  readonly text: string;
  readonly end: number;
}

/** A `cat -n` style line number, as Claude Code's Read output carries. */
const LINE_NUMBER = /^\s*\d+[\t→]/;
const WORD = /[A-Za-z0-9_./:@-]{12,}/g;
/** Words with a digit, a path or member character, or an inner capital: ids, hashes, paths, camelCase names. */
const DISTINCTIVE_WORD = /[\d/._@]|[a-z][A-Z]/;
/** `/system-reminder` from `</system-reminder>`, `/compact`: a tag or command name, not something a result taught. */
const TAG_LIKE = /^\/[^/.]+$/;

/** Lines of at least `MIN_LINE_CHARS`, without a leading line number and trimmed. */
export function lineFragments(text: string): Fragment[] {
  const fragments: Fragment[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const end = offset + raw.length;
    const line = raw.replace(LINE_NUMBER, "").trim();
    if (line.length >= MIN_LINE_CHARS && /[A-Za-z0-9]/.test(line)) {
      fragments.push({ text: line, end });
    }
    offset = end + 1;
  }
  return fragments;
}

/** Ids, hashes, paths and camelCase names of at least `MIN_TOKEN_CHARS`; plain English words are left out. */
export function wordFragments(text: string): Fragment[] {
  const fragments: Fragment[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0].replace(/[.:,-]+$/, "");
    if (word.length >= MIN_TOKEN_CHARS && DISTINCTIVE_WORD.test(word) && !TAG_LIKE.test(word)) {
      fragments.push({ text: word, end: (match.index ?? 0) + word.length });
    }
  }
  return fragments;
}

export function fragmentsOf(text: string): Fragment[] {
  return [...lineFragments(text), ...wordFragments(text)];
}

/** Every string inside a tool input, joined by new lines. */
export function inputStrings(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(inputStrings).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(inputStrings).join("\n");
  return "";
}

/** What the model wrote in a message: its text and its tool inputs, not tool output. */
export function authoredText(message: Message): string {
  if (message.role !== "assistant") return "";
  return [message.text, ...message.toolUses.map((tool) => inputStrings(tool.input))].join("\n");
}

/** Every piece of text a message holds: text, tool inputs and tool output. */
export function allText(message: Message): string {
  return [
    message.text,
    ...message.toolUses.map((tool) => inputStrings(tool.input)),
    ...(message.toolResults ?? []).map((result) => result.text),
  ].join("\n");
}
