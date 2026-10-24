import { err, ok, type Result } from "@9tech.solutions/pruner-domain";

export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

type InputReadError = "input_too_large" | "input_read_failed";

function byteLength(chunk: string | Uint8Array): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
}

function asBuffer(chunk: string | Uint8Array): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** Collect stdin only while its encoded size remains within the protocol limit. */
export async function readBoundedInput(
  stream: AsyncIterable<string | Uint8Array>,
): Promise<Result<string, InputReadError>> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const length = byteLength(chunk);
      if (size + length > MAX_INPUT_BYTES) return err("input_too_large");
      chunks.push(asBuffer(chunk));
      size += length;
    }
  } catch {
    return err("input_read_failed");
  }
  return ok(Buffer.concat(chunks, size).toString("utf8"));
}
