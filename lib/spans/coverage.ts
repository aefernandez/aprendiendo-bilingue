import type { WordToken } from './tokenize';
import type { SpanItem } from './validate';

/**
 * Share of word tokens inside swapped (non-cognate) kept ranges. Numeric tokens
 * are excluded from numerator and denominator. Returns 0 when there are no words.
 */
export function coverage(tokens: readonly WordToken[], kept: readonly SpanItem[]): number {
  const words = tokens.filter(t => !t.numeric).length;
  if (!words) return 0;
  let inside = 0;
  for (const k of kept) {
    if (k.cognate) continue;
    for (let i = k.startWord; i <= k.endWord; i++) if (!tokens[i].numeric) inside++;
  }
  return inside / words;
}
