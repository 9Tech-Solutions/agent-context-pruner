import type { ToolCall } from "./tool-call.ts";

/** Input keys that hold the file a call works on, across hosts. */
export const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path"] as const;

/** The file a call works on, read from the first path key it has, with forward slashes. */
export function callPath(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[] = PATH_KEYS,
): string | undefined {
  const value = keys.map((key) => input[key]).find((v) => typeof v === "string");
  return typeof value === "string" ? value.trim().replace(/\\/g, "/") : undefined;
}

/** Path-like words of the instructions (`src/auth.ts`, `README.md`), lower-cased with forward slashes. */
export function namedPaths(instructions: string): string[] {
  return (instructions.match(/[\w.@~-]*[./\\][\w./\\@~-]+/g) ?? [])
    .map((word) =>
      word
        .replace(/\\/g, "/")
        .replace(/[.,;:]+$/, "")
        .toLowerCase(),
    )
    .filter((word) => word.length >= 3);
}

/** Whether `path` is one the person named: the same path, or one ending in `/<named>`. */
export function isNamed(path: string, named: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return named.some((word) => lower === word || lower.endsWith(`/${word}`));
}

/**
 * Pins the calls on files the person named in the compaction's instructions
 * (`/compact keep src/auth.ts`), so they stay whole whatever a model scores:
 * what the person asked to keep is not left to a model's judgment.
 */
export function pinNamed(calls: readonly ToolCall[], instructions: string): ToolCall[] {
  const named = namedPaths(instructions);
  if (named.length === 0) return [...calls];
  return calls.map((call) => {
    if (call.pinned) return call;
    const path = callPath(call.input);
    return path && isNamed(path, named) ? { ...call, pinned: true } : call;
  });
}
