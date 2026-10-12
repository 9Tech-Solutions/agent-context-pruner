/** Estimates how many tokens a model needs for `text`. */
export type TokenEstimator = (text: string) => number;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated by
 * fast-jev-compaction against the usage Jev reports for real transcripts,
 * where it lands 2 to 18% above the true count. Other models ship their own
 * estimator through `ModelCapabilities` when this one does not fit.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}
