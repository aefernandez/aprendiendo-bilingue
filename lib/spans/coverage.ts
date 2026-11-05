import type { WordToken } from './tokenize';
import type { SpanItem } from './validate';

/**
 * Share of word tokens inside swapped (non-cognate) kept ranges. Numeric tokens
 * are excluded from numerator and denominator. Returns 0 when there are no words.
 *
 * Works on absolute offsets, so `tokens` may be one chunk's tokens or the whole
 * text's, and `kept` may be merged from several chunks (whose word indices are
 * chunk-local and so are not used here).
 */
export function coverage(tokens: readonly WordToken[], kept: readonly SpanItem[]): number {
  const words = tokens.filter(t => !t.numeric);
  if (!words.length) return 0;
  const ranges = kept.filter(k => !k.cognate).sort((a, b) => a.start - b.start);
  let inside = 0;
  let r = 0;
  for (const t of words) {
    while (r < ranges.length && ranges[r].end <= t.start) r++;
    if (r < ranges.length && ranges[r].start <= t.start && t.end <= ranges[r].end) inside++;
  }
  return inside / words.length;
}
