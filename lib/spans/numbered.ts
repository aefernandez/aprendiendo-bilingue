import type { TextRange, WordToken } from './tokenize';

/**
 * Tokens lying wholly inside `range`, re-indexed from 0 (indices are chunk-local;
 * offsets stay absolute). A token straddling the range edge is left out.
 */
export function chunkTokens(tokens: readonly WordToken[], range: TextRange): WordToken[] {
  const out: WordToken[] = [];
  for (const t of tokens) {
    if (t.start >= range.start && t.end <= range.end) out.push({ ...t, i: out.length });
  }
  return out;
}

/**
 * The numbered input the model reads: "[0]Juan [1]come [2]pan." Text between
 * tokens (spaces, punctuation, masked URLs) is copied verbatim.
 * `tokens` must lie inside `range` and be in text order.
 */
export function numberedInput(
  text: string,
  tokens: readonly WordToken[],
  range: TextRange = { start: 0, end: text.length },
): string {
  let out = '';
  let cursor = range.start;
  for (const t of tokens) {
    out += text.slice(cursor, t.start) + `[${t.i}]` + t.text;
    cursor = t.end;
  }
  return out + text.slice(cursor, range.end);
}
