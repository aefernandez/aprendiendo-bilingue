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
 * Search tiers, tried in this order (each exact first, then case-insensitive;
 * case folding stays accent-sensitive, so el ≠ él):
 * exact / case: the cursor's sentence, forward from the cursor — first free hit wins;
 * backtrack:    the cursor's sentence, before the cursor (out-of-order item);
 *               the cursor does not move;
 * next:         the following sentence. Backtrack and next are pooled: the
 *               item is placed only if exactly one free hit (exact or
 *               case-insensitive) exists across both windows, else 'ambiguous';
 * ahead:        a later sentence (the model skipped sentences with nothing to
 *               swap) — only when the phrase has exactly one free occurrence in
 *               the whole chunk.
 * Nothing else is searched: a phrase that is ambiguous or out of these windows
 * is dropped rather than guessed (wrong occurrences of function words like
 * que/como/la invert meaning).
 */
export type AlignHow = 'exact' | 'case' | 'backtrack' | 'next' | 'ahead';

/**
 * Why a phrase was not aligned: no occurrence (align), more than one equally
 * good free occurrence (ambiguous), or every occurrence was rejected for this reason.
 */
export type AlignFail = 'align' | 'ambiguous' | 'boundary' | 'masked' | 'sentence' | 'overlap';

export interface AlignHit extends TextRange {
  how: AlignHow;
}

export interface Aligner {
  /**
   * Aligns the next phrase and advances the cursor (except on a backtrack hit).
   * The cursor also advances for a phrase the validator later drops (numeric,
   * protected…): the model's order still says where it is in the text.
   */
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
  // A boundary cuts a token when it falls strictly inside one. Exception: a
  // phrase may stop before a trailing possessive apostrophe ("dogs" in dogs').
  const cutsToken = (off: number, isEnd: boolean): boolean => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = tokens[mid];
      if (off <= t.start) hi = mid - 1;
      else if (off >= t.end) lo = mid + 1;
      else return !(isEnd && t.end === off + 1 && /['’ʼ]/.test(text[off]));
    }
    return false;
  };
  const intersects = (list: readonly TextRange[], a: number, b: number) => list.some(r => r.start < b && r.end > a);

  const check = (a: number, b: number): AlignFail | null => {
    if (cutsToken(a, false) || cutsToken(b, true)) return 'boundary';
    if (intersects(masked, a, b)) return 'masked';
    if (sentenceAt(a) !== sentenceAt(b - 1)) return 'sentence';
    if (intersects(occupied, a, b)) return 'overlap';
    return null;
  };

  const FAIL_RANK: Record<AlignFail, number> = { align: 0, boundary: 1, masked: 2, sentence: 3, overlap: 4, ambiguous: 5 };

  interface Found extends TextRange {
    endN: number;
  }
  /** Up to `limit` free, fitting matches that start in [from, to) and end by `endBy`. */
  function collect(re: RegExp, from: number, to: number, endBy: number, limit: number, seen: { fail: AlignFail }): Found[] {
    const out: Found[] = [];
    re.lastIndex = from;
    for (let m = re.exec(cmp.norm); m && out.length < limit; m = re.exec(cmp.norm)) {
      const p = m.index;
      const q = p + m[0].length;
      if (p >= to || q > endBy || m[0].length === 0) break;
      const a = cmp.origStart[p];
      const b = cmp.origEnd[q - 1];
      const why = check(a, b);
      if (!why) out.push({ start: a, end: b, endN: q });
      else if (FAIL_RANK[why] > FAIL_RANK[seen.fail]) seen.fail = why;
      re.lastIndex = p + 1;
    }
    return out;
  }

  const rangeStartN = cmp.toNorm[range.start];
  const rangeEndN = cmp.toNorm[range.end];

  return {
    align(phrase) {
      const src = phrasePattern(phrase);
      if (!src) return { fail: 'align' };
      const exact = new RegExp(src, 'gu');
      const ci = new RegExp(src, 'giu');
      const curOrig = cursor >= cmp.origStart.length ? range.end : cmp.origStart[cursor];
      const si = sentenceAt(curOrig);
      const clampN = (orig: number) => cmp.toNorm[Math.min(Math.max(orig, range.start), range.end)];
      const sentStartN = clampN(sentences[si].start);
      const sentEndN = clampN(sentences[si].end);
      const seen = { fail: 'align' as AlignFail };

      // (a) forward in the cursor's sentence: the in-order case, first hit wins.
      for (const [re, how] of [[exact, 'exact'], [ci, 'case']] as const) {
        const [hit] = collect(re, cursor, sentEndN, sentEndN, 1, seen);
        if (hit) {
          cursor = hit.endN;
          return { start: hit.start, end: hit.end, how };
        }
      }
      // (b) backward in the cursor's sentence vs (c) the next sentence. Both are
      // plausible after a miss in (a) — out-of-order item, or the model moved
      // on — so each window collects exact AND case-insensitive hits, and an
      // item is placed only when exactly one free hit exists across both.
      const back = [...collect(exact, sentStartN, cursor, sentEndN, 2, seen), ...collect(ci, sentStartN, cursor, sentEndN, 2, seen)];
      let fwd: Found[] = [];
      if (si + 1 < sentences.length && sentences[si + 1].start < range.end) {
        const ns = clampN(sentences[si + 1].start);
        const ne = clampN(sentences[si + 1].end);
        fwd = [...collect(exact, ns, ne, ne, 2, seen), ...collect(ci, ns, ne, ne, 2, seen)];
      }
      const uniq = (list: Found[]) => list.filter((h, k) => list.findIndex(x => x.start === h.start) === k);
      const candidates = [...uniq(back).map(h => ({ h, how: 'backtrack' as const })), ...uniq(fwd).map(h => ({ h, how: 'next' as const }))];
      if (candidates.length > 1) return { fail: 'ambiguous' };
      if (candidates.length === 1) {
        const { h, how } = candidates[0];
        if (how === 'next') cursor = h.endN; // a backtrack hit leaves the cursor where it is
        return { start: h.start, end: h.end, how };
      }
      // (d) further ahead: only a phrase that occurs once (free) in the whole chunk.
      const afterN = si + 2 < sentences.length ? clampN(sentences[si + 2].start) : rangeEndN;
      if (afterN < rangeEndN) {
        for (const re of [exact, ci]) {
          const all = collect(re, rangeStartN, rangeEndN, rangeEndN, 2, seen);
          if (all.length > 1) return { fail: 'ambiguous' };
          if (all.length === 1) {
            if (all[0].endN <= afterN) break; // the only occurrence is behind: not ours to guess
            cursor = all[0].endN;
            return { start: all[0].start, end: all[0].end, how: 'ahead' };
          }
        }
      }
      return { fail: seen.fail };
    },
    occupy(span) {
      occupied.push({ start: span.start, end: span.end });
    },
  };
}
