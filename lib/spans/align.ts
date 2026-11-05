// In-order aligner for the substring span format: finds each source phrase the
// model copied back in the original text and returns absolute offsets.
//
// Matching works on a comparison copy of the text: NFC per character cluster,
// plus a one-for-one map of curly quotes to straight ones and NBSP-like spaces
// to a plain space. The same map is applied to the phrase, and whitespace runs
// in the phrase match any whitespace run. Offsets are mapped back, so the
// original text is never rewritten.

import type { TextRange, WordToken } from './tokenize';

export interface AlignCtx {
  /** The whole original text. */
  text: string;
  /** Word tokens of the chunk (or the whole text), absolute offsets, in order. */
  tokens: readonly WordToken[];
  /** Masked ranges (URLs, emails, domains) from tokenizeWords. */
  masked: readonly TextRange[];
  /** Sentence ranges, absolute. Omitted → the search range is one sentence. */
  sentences?: readonly TextRange[];
  /** Where to search (the chunk). Defaults to the whole text. */
  range?: TextRange;
}

/**
 * exact: found forward from the cursor within the cursor's and the next sentence;
 * case: same window, case-insensitive (accent-sensitive: el ≠ él);
 * backtrack: earlier in the cursor's sentence (out-of-order item);
 * jump: anywhere else in the range.
 */
export type AlignHow = 'exact' | 'case' | 'backtrack' | 'jump';

/** Why a phrase was not aligned: no occurrence at all, or every occurrence was rejected for this reason. */
export type AlignFail = 'align' | 'boundary' | 'masked' | 'sentence' | 'overlap';

export interface AlignHit extends TextRange {
  how: AlignHow;
}

export interface Aligner {
  /** Aligns the next phrase and advances the cursor. */
  align(phrase: string): AlignHit | { fail: AlignFail };
  /** Marks a kept span so later phrases can't overlap it. */
  occupy(span: TextRange): void;
}

const CHAR_MAP: Record<string, string> = {
  '’': "'", '‘': "'", 'ʼ': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
};
function mapChars(s: string): string {
  let out = '';
  for (const ch of s) out += CHAR_MAP[ch] ?? ch;
  return out;
}

interface Comparable {
  norm: string;
  /** Original start / end offset of the cluster each norm char came from. */
  origStart: number[];
  origEnd: number[];
  /** Norm offset for each original offset (cluster starts; inner offsets map to their cluster). */
  toNorm: number[];
}

function comparable(text: string): Comparable {
  const origStart: number[] = [];
  const origEnd: number[] = [];
  const toNorm = new Array<number>(text.length + 1).fill(0);
  let norm = '';
  for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const o = m.index ?? 0;
    const e = o + m[0].length;
    for (let k = o; k < e; k++) toNorm[k] = norm.length;
    const n = mapChars(m[0].normalize('NFC'));
    for (let k = 0; k < n.length; k++) {
      origStart.push(o);
      origEnd.push(e);
    }
    norm += n;
  }
  toNorm[text.length] = norm.length;
  return { norm, origStart, origEnd, toNorm };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Regex source for a phrase: NFC, mapped, whitespace runs → \s+. Empty when nothing is left. */
export function phrasePattern(phrase: string): string {
  const parts = mapChars(phrase.normalize('NFC')).trim().split(/\s+/).filter(Boolean);
  return parts.map(escapeRe).join('\\s+');
}

export function createAligner(ctx: AlignCtx): Aligner {
  const { text, tokens, masked } = ctx;
  const range = ctx.range ?? { start: 0, end: text.length };
  const sentences = (ctx.sentences?.length ? [...ctx.sentences] : [range]).sort((a, b) => a.start - b.start);
  const cmp = comparable(text);
  const occupied: TextRange[] = [];
  let cursor = cmp.toNorm[range.start];
  const rangeStartN = cmp.toNorm[range.start];
  const rangeEndN = cmp.toNorm[range.end];

  const sentenceAt = (orig: number): number => {
    let lo = 0;
    let hi = sentences.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sentences[mid].start <= orig) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // A boundary cuts a token when it falls strictly inside one.
  const cutsToken = (off: number): boolean => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = tokens[mid];
      if (off <= t.start) hi = mid - 1;
      else if (off >= t.end) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const intersects = (list: readonly TextRange[], a: number, b: number) => list.some(r => r.start < b && r.end > a);

  const check = (a: number, b: number): AlignFail | null => {
    if (cutsToken(a) || cutsToken(b)) return 'boundary';
    if (intersects(masked, a, b)) return 'masked';
    if (sentenceAt(a) !== sentenceAt(b - 1)) return 'sentence';
    if (intersects(occupied, a, b)) return 'overlap';
    return null;
  };

  const FAIL_RANK: Record<AlignFail, number> = { align: 0, boundary: 1, masked: 2, sentence: 3, overlap: 4 };

  function search(re: RegExp, from: number, to: number, seen: { fail: AlignFail }): TextRange & { endN: number } | null {
    re.lastIndex = Math.max(from, rangeStartN);
    for (let m = re.exec(cmp.norm); m; m = re.exec(cmp.norm)) {
      const p = m.index;
      const q = p + m[0].length;
      if (q > Math.min(to, rangeEndN) || m[0].length === 0) return null;
      const a = cmp.origStart[p];
      const b = cmp.origEnd[q - 1];
      const why = check(a, b);
      if (!why) return { start: a, end: b, endN: q };
      if (FAIL_RANK[why] > FAIL_RANK[seen.fail]) seen.fail = why;
      re.lastIndex = p + 1;
    }
    return null;
  }

  return {
    align(phrase) {
      const src = phrasePattern(phrase);
      if (!src) return { fail: 'align' };
      const exact = new RegExp(src, 'gu');
      const ci = new RegExp(src, 'giu');
      const curOrig = cmp.origStart[Math.min(cursor, cmp.origStart.length - 1)] ?? range.end;
      const si = sentenceAt(cursor >= cmp.norm.length ? range.end : curOrig);
      const next = sentences[Math.min(si + 1, sentences.length - 1)];
      const windowEnd = cmp.toNorm[Math.min(next.end, range.end)];
      const sentStart = cmp.toNorm[Math.max(sentences[si].start, range.start)];
      const seen = { fail: 'align' as AlignFail };
      const attempts: [RegExp, number, number, AlignHow][] = [
        [exact, cursor, windowEnd, 'exact'],
        [ci, cursor, windowEnd, 'case'],
        [exact, sentStart, windowEnd, 'backtrack'],
        [ci, sentStart, windowEnd, 'backtrack'],
        [exact, rangeStartN, rangeEndN, 'jump'],
        [ci, rangeStartN, rangeEndN, 'jump'],
      ];
      for (const [re, from, to, how] of attempts) {
        const hit = search(re, from, to, seen);
        if (hit) {
          cursor = Math.max(cursor, hit.endN);
          return { start: hit.start, end: hit.end, how };
        }
      }
      return { fail: seen.fail };
    },
    occupy(span) {
      occupied.push({ start: span.start, end: span.end });
    },
  };
}
