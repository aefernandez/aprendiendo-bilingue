// Run-shape metric: how long are the unbroken stretches of target language the
// reader sees? Coverage (coverage.ts) says how MUCH text is swapped; it cannot
// tell "one word every sentence" from "whole clauses every few sentences".
// Prototype learning #1: measure RUNS, not per-item lengths. Splitting a clause
// into adjacent items cuts the median item length but not what the reader sees,
// so adjacent swaps must be joined into one run.
//
// DEFINITIONS
// - Swapped range: a kept item with `cognate === false`. Cognates are kept but
//   not swapped (same as coverage()), so a cognate range counts as source text
//   and BREAKS a run. (Alternative: treat cognates as target text that extends
//   a run; rejected to stay consistent with coverage.)
// - Run: a maximal sequence of swapped ranges, sorted by `start`, where the
//   original text between consecutive ranges is only horizontal whitespace
//   and/or commas (or nothing). Any other character breaks the run: a word, a
//   period, semicolon, quote, dash, or a line break. Offsets are absolute, so
//   items merged from several chunks work.
// - Run length: the sum over its ranges of the word-token count of the
//   TRANSLATION (what the reader sees), via tokenizeWords. Numeric tokens are
//   INCLUDED ("il treno delle 8:15" is 4), unlike coverage() which excludes
//   them, because they are visible parts of the run.
//
// Report only: nothing here drops or changes items, and nothing enforces it.

import type { Level } from '../types';
import { tokenizeWords } from './tokenize';
import type { SpanItem } from './validate';

export interface RunStats {
  /** Number of runs. */
  runs: number;
  /** Total target words across runs. */
  words: number;
  /** Median run length (mean of the two middle values when even); 0 if no runs. */
  median: number;
  max: number;
  /** Share of runs longer than N words, for N in {4, 8}. 0 when no runs. */
  over: Record<number, number>;
  /** Run lengths in text order. */
  lengths: number[];
}

export interface LengthRule {
  /** A run longer than this many words is "long". */
  maxWords: number;
  /** At most this share of runs may be long. */
  maxShareOver: number;
  maxMedian: number;
}

/** Per level; null = free. Calibrated on reviewed Italian L2/L3 stories. */
export const LENGTH_RULES: Readonly<Record<Level, LengthRule | null>> = {
  1: { maxWords: 4, maxShareOver: 0.1, maxMedian: 3 },
  2: { maxWords: 8, maxShareOver: 0.3, maxMedian: 6 },
  3: null,
};

// Nothing, horizontal whitespace, commas. Line breaks and everything else break.
const JOINER = /^[^\S\r\n]*(?:,[^\S\r\n]*)*$/;

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function share(lengths: readonly number[], over: number): number {
  return lengths.length ? lengths.filter(l => l > over).length / lengths.length : 0;
}

export function runStats(
  text: string,
  kept: readonly Pick<SpanItem, 'start' | 'end' | 'cognate' | 'translation'>[],
  targetLocale: string,
): RunStats {
  const ranges = kept.filter(k => !k.cognate).sort((a, b) => a.start - b.start);
  const lengths: number[] = [];
  let cur = 0;
  let prevEnd = -1;
  for (const k of ranges) {
    const n = tokenizeWords(k.translation, targetLocale).tokens.length;
    if (prevEnd >= 0 && JOINER.test(text.slice(prevEnd, k.start))) {
      cur += n;
    } else {
      if (prevEnd >= 0) lengths.push(cur);
      cur = n;
    }
    prevEnd = k.end;
  }
  if (prevEnd >= 0) lengths.push(cur);

  const sorted = [...lengths].sort((a, b) => a - b);
  return {
    runs: lengths.length,
    words: lengths.reduce((a, b) => a + b, 0),
    median: median(sorted),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    over: { 4: share(lengths, 4), 8: share(lengths, 8) },
    lengths,
  };
}

/** Reports problems against the level's rule. Never drops or changes items. */
export function checkRunShape(stats: RunStats, level: Level): { ok: boolean; violations: string[] } {
  const rule = LENGTH_RULES[level];
  if (!rule || !stats.runs) return { ok: true, violations: [] };
  const violations: string[] = [];
  const s = share(stats.lengths, rule.maxWords);
  if (s > rule.maxShareOver) {
    violations.push(`${pct(s)} of runs over ${rule.maxWords} words (max ${pct(rule.maxShareOver)})`);
  }
  if (stats.median > rule.maxMedian) {
    violations.push(`median run ${stats.median} words (max ${rule.maxMedian})`);
  }
  return { ok: violations.length === 0, violations };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** One line for diagnostics / eval, e.g. `runs 16 · median 6 · >8w 38% (L2 ≤30%) · max 22 · shape FAIL`. */
export function formatRunStats(stats: RunStats, level: Level): string {
  const rule = LENGTH_RULES[level];
  const parts = [`runs ${stats.runs}`, `median ${stats.median}`];
  if (rule) {
    parts.push(`>${rule.maxWords}w ${pct(share(stats.lengths, rule.maxWords))} (L${level} ≤${pct(rule.maxShareOver)})`);
  }
  parts.push(`max ${stats.max}`);
  parts.push(`shape ${rule ? (checkRunShape(stats, level).ok ? 'ok' : 'FAIL') : 'free'}`);
  return parts.join(' · ');
}
