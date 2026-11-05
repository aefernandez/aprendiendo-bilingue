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

// A literal "[12]" in the source (a citation) would read like an index marker,
// so square brackets in the gap text are shown fullwidth: "［[3]12］".

/**
 * The numbered input the model reads: "[0]Juan [1]come [2]pan." Text between
 * tokens (spaces, punctuation, masked URLs) is copied verbatim, except that
 * literal square brackets become fullwidth ［ ］. This string is prompt-only: offsets never
 * depend on it. `tokens` must lie inside `range` and be in text order.
 */
export function numberedInput(
  text: string,
  tokens: readonly WordToken[],
  range: TextRange = { start: 0, end: text.length },
): string {
  let out = '';
  let cursor = range.start;
  for (const t of tokens) {
    out += gap(text.slice(cursor, t.start)) + `[${t.i}]` + t.text;
    cursor = t.end;
  }
  return out + gap(text.slice(cursor, range.end));
}

function gap(s: string): string {
  return s.replace(/\[/g, '［').replace(/\]/g, '］');
}
