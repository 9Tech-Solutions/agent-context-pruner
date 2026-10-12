import { err, ok, type ModelError, type Result } from "@9tech.solutions/pruner-domain";

export interface BatchLimits {
  /** Token budget per batch, after the state and request envelope. */
  readonly budget: number;
  /** Items per batch, for servers that cap questions per request. */
  readonly maxItems: number;
}

/** Splits `items` into batches that each stay within the token budget and the item cap. */
export function batchByBudget<T>(
  items: readonly T[],
  costOf: (item: T) => number,
  limits: BatchLimits,
): Result<T[][], ModelError> {
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = costOf(item);
    if (cost > limits.budget) {
      return err({
        kind: "limit",
        message: `the state leaves no room for questions (${limits.budget} tokens left, one call needs ${cost})`,
      });
    }
    if (current.length > 0 && (used + cost > limits.budget || current.length >= limits.maxItems)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return ok(batches);
}

/** Maps `items` through `fn` with at most `limit` calls in flight, keeping the order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
