/**
 * Probability that a random positive scores above a random negative (ties
 * count half): 1 is a perfect ranking, 0.5 is no better than chance.
 * Null when there are no positives or no negatives to compare.
 */
export function auc(scores: readonly number[], positives: readonly boolean[]): number | null {
  const pairs = scores.map((score, i) => ({ score, positive: positives[i] === true }));
  const p = pairs.filter((pair) => pair.positive).length;
  const n = pairs.length - p;
  if (p === 0 || n === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k]!.positive) rankSum += averageRank;
    i = j + 1;
  }
  return (rankSum - (p * (p + 1)) / 2) / (p * n);
}
