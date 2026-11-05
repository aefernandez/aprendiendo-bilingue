// Validator for the model's span items.
//
// TUPLE LAYOUT (indices are chunk-local word indices, ranges INCLUSIVE):
//   single word:  [s, s, anchor, translation, pos]                 (5 elements)
//   multi-word:   [s, e, startAnchor, endAnchor, translation, pos] (6 elements)
// `anchor`/`startAnchor` is word s copied exactly; `endAnchor` is word e.
// The element count is the discriminator. A 6-tuple with s == e is accepted
// (endAnchor is then checked against word s). Lenient forms, for models that
// drop trailing fields: [s, s, anchor, translation] (no pos), and a 5-tuple with
// e > s whose last element is not a POS code is read as
// [s, e, startAnchor, endAnchor, translation]. Any other item with e > s carries
// no end anchor, so its end can't be verified and it is dropped ('endAnchor').
// Indices may be integers or digit strings ("3"). A non-string or unknown pos
// keeps the item with `pos: undefined`.

import { isPosCode, type PosCode } from '../pos';
import type { TextRange, WordToken } from './tokenize';

export interface SpanItem {
  /**
   * Chunk-local inclusive word indices (into ValidateCtx.tokens). Use the
   * absolute `start`/`end` offsets once items from several chunks are merged.
   */
  startWord: number;
  endWord: number;
  /** Absolute UTF-16 offsets into the original text. */
  start: number;
  end: number;
  source: string;
  translation: string;
  pos?: PosCode;
  /** Translation equals the source: kept, but not swapped. */
  cognate: boolean;
}

export type DropReason =
  | 'shape' | 'bounds' | 'anchor' | 'endAnchor' | 'numeric' | 'sentence' | 'masked' | 'overlap'
  | 'empty' | 'newline' | 'url' | 'length';

export interface ValidationStats {
  received: number;
  kept: number;
  cognates: number;
  /** Start anchor matched at the given index. */
  anchorExact: number;
  /** Start anchor did not match at the given index (before repair). */
  anchorMismatch: number;
  /** Start anchor found at ±1/±2 and the whole item shifted. */
  anchorRepaired: number;
  /** Multi-word items whose end anchor matched at e (inclusive end). */
  endAnchorExact: number;
  /** Multi-word items whose end anchor matched at e-1 (exclusive end, pulled back). */
  exclusiveEnds: number;
  /** End anchor found at e+1 or ±2 and the end moved. */
  endRepaired: number;
  /** Chunk-level: most multi-word items used exclusive ends. Only breaks e/e-1 ties. */
  exclusiveMode: boolean;
  dropped: Partial<Record<DropReason, number>>;
}

export interface ValidateCtx {
  /** The whole original text (token offsets are absolute). */
  text: string;
  /** Chunk tokens, indexed from 0. */
  tokens: readonly WordToken[];
  /**
   * Masked ranges from tokenizeWords (URLs, emails, domains). Required: a span
   * whose range covers one is dropped, or the swap would delete the URL.
   */
  masked: readonly TextRange[];
  /** Sentence ranges (absolute offsets). Omitted → the chunk is one sentence. */
  sentences?: readonly TextRange[];
}

export interface ValidationResult {
  kept: SpanItem[];
  stats: ValidationStats;
}

const URLISH = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.)/iu;

/** NFC, lowercase, curly quotes/hyphens straightened, punctuation stripped from the edges. */
export function normWord(s: string): string {
  return s
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[’ʼ‘`´]/g, "'")
    .replace(/[‐‑]/g, '-')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Exact (normalized) match, or the model copied only one part of a merged token:
 * the first part for a start anchor ("well" → well-known), the last part for an
 * end anchor ("known" → well-known).
 */
export function anchorMatches(
  anchor: string,
  token: string,
  side: 'start' | 'end' = 'start',
  ignoreAccents = false,
): boolean {
  const a = ignoreAccents ? stripAccents(normWord(anchor)) : normWord(anchor);
  const t = ignoreAccents ? stripAccents(normWord(token)) : normWord(token);
  if (!a) return false;
  if (a === t) return true;
  if (a.length < 2) return false;
  if (side === 'start') return t.startsWith(a) && /^['-]/.test(t.slice(a.length));
  return t.endsWith(a) && /['-]$/.test(t.slice(0, t.length - a.length));
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

function normPhrase(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase().replace(/[’ʼ‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

/** Sentence id per token: index of the last range starting at or before the token. */
export function sentenceIndexOf(tokens: readonly WordToken[], sentences?: readonly TextRange[]): number[] {
  if (!sentences || sentences.length === 0) return tokens.map(() => 0);
  const sorted = [...sentences].sort((a, b) => a.start - b.start);
  let s = 0;
  return tokens.map(t => {
    while (s + 1 < sorted.length && sorted[s + 1].start <= t.start) s++;
    return s;
  });
}

interface Tuple {
  s: number;
  e: number;
  anchor: string;
  endAnchor?: string;
  translation: string;
  pos?: PosCode;
}

function toIndex(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)) return Number(v);
  return null;
}

function readTuple(it: unknown): Tuple | null {
  if (!Array.isArray(it) || it.length < 4 || it.length > 6) return null;
  const s = toIndex(it[0]);
  const e = toIndex(it[1]);
  if (s === null || e === null) return null;
  const strs = it.slice(2);
  let anchor: unknown, endAnchor: unknown, translation: unknown, pos: unknown;
  if (it.length === 6) [anchor, endAnchor, translation, pos] = strs;
  else if (it.length === 4) [anchor, translation] = strs;
  else if (e > s && !isPosCode(it[4])) [anchor, endAnchor, translation] = strs;
  else [anchor, translation, pos] = strs;
  if (typeof anchor !== 'string' || typeof translation !== 'string') return null;
  if (endAnchor !== undefined && typeof endAnchor !== 'string') return null;
  return {
    s,
    e,
    anchor,
    endAnchor: endAnchor as string | undefined,
    translation,
    pos: isPosCode(pos) ? pos : undefined,
  };
}

// both = end anchor at e and e-1 (repeated word); exclOrNext = at e-1 and e+1.
// Both are settled by the chunk mode after every item has been read.
type EndState = 'inclusive' | 'exclusive' | 'both' | 'exclOrNext' | 'fixed';

interface Candidate {
  s: number;
  e: number;
  translation: string;
  pos?: PosCode;
  end: EndState;
}

/**
 * Checks raw items against the chunk's tokens. Pure; never throws.
 * Order of checks: shape → start anchor (±1/±2 repair, both ends shifted; equally
 * near twins → drop) → end anchor for multi-word items (e, else e-1 = exclusive
 * end, else e+1, else ±2; equally plausible twins → drop) → bounds → sort →
 * numeric endpoints → sentence crossing → masked range inside → overlap →
 * translation checks → cognate.
 */
export function validateItems(items: readonly unknown[], ctx: ValidateCtx): ValidationResult {
  const { text, tokens } = ctx;
  const n = tokens.length;
  const sentenceOf = sentenceIndexOf(tokens, ctx.sentences);
  const stats: ValidationStats = {
    received: items.length, kept: 0, cognates: 0,
    anchorExact: 0, anchorMismatch: 0, anchorRepaired: 0,
    endAnchorExact: 0, exclusiveEnds: 0, endRepaired: 0, exclusiveMode: false,
    dropped: {},
  };
  const drop = (r: DropReason) => {
    stats.dropped[r] = (stats.dropped[r] ?? 0) + 1;
  };

  const cands: Candidate[] = [];
  for (const it of items) {
    const tup = readTuple(it);
    if (!tup) {
      drop('shape');
      continue;
    }
    let { s, e } = tup;
    if (e < s) {
      drop('bounds');
      continue;
    }

    // Start anchor.
    const startAt = (k: number) => k >= 0 && k < n && anchorMatches(tup.anchor, tokens[k].text, 'start');
    // Accent-insensitive only at the given index: in a repair search it could
    // pick a wrong twin (el/él, si/sí).
    if (startAt(s) || (s >= 0 && s < n && anchorMatches(tup.anchor, tokens[s].text, 'start', true))) {
      stats.anchorExact++;
    } else {
      stats.anchorMismatch++;
      let shift = 0;
      for (const dist of [1, 2]) {
        const lo = startAt(s - dist);
        const hi = startAt(s + dist);
        if (lo && hi) break; // equidistant twins: ambiguous
        if (lo || hi) {
          shift = lo ? -dist : dist;
          break;
        }
      }
      if (!shift) {
        drop('anchor');
        continue;
      }
      s += shift;
      e += shift;
      stats.anchorRepaired++;
    }

    // End anchor.
    let end: EndState = 'inclusive';
    if (tup.endAnchor === undefined) {
      if (e > s) {
        drop('endAnchor');
        continue;
      }
    } else {
      const ea = tup.endAnchor;
      const endAt = (k: number) => k >= s && k < n && anchorMatches(ea, tokens[k].text, 'end');
      const atE = endAt(e) || (e >= s && e < n && anchorMatches(ea, tokens[e].text, 'end', true));
      const atPrev = endAt(e - 1);
      const atNext = endAt(e + 1);
      // Same tie rule as the start anchor: equally plausible positions → drop.
      // e-1 (exclusive end) and e+1 are both one step away; e+1 and e-2 are
      // both one step from the exclusive reading e-1.
      if (atE && atPrev) end = 'both';
      else if (atE) end = 'inclusive';
      else if (atPrev && atNext) end = 'exclOrNext';
      else if (atPrev) {
        end = 'exclusive';
        e -= 1;
      } else {
        let moved = 0;
        const atPrev2 = endAt(e - 2);
        if (atNext) moved = atPrev2 ? 0 : 1;
        else if (atPrev2 !== endAt(e + 2)) moved = atPrev2 ? -2 : 2;
        if (!moved) {
          drop('endAnchor');
          continue;
        }
        e += moved;
        end = 'fixed';
        stats.endRepaired++;
      }
      if (end === 'inclusive' && e > s) stats.endAnchorExact++;
      if (end === 'exclusive') stats.exclusiveEnds++;
    }

    if (s < 0 || e >= n || e < s) {
      drop('bounds');
      continue;
    }
    cands.push({ s, e, translation: tup.translation, pos: tup.pos, end });
  }

  // Chunk-level mode only resolves items whose end anchor matches both e and e-1
  // (a repeated word): never overrides an unambiguous end anchor.
  stats.exclusiveMode = stats.exclusiveEnds >= 2 && stats.exclusiveEnds > stats.endAnchorExact;
  const resolved: Candidate[] = [];
  for (const c of cands) {
    if (c.end === 'both') {
      if (stats.exclusiveMode) {
        c.e -= 1;
        stats.exclusiveEnds++;
      } else if (c.e > c.s) stats.endAnchorExact++;
    } else if (c.end === 'exclOrNext') {
      if (!stats.exclusiveMode) {
        drop('endAnchor');
        continue;
      }
      c.e -= 1;
      stats.exclusiveEnds++;
    }
    resolved.push(c);
  }

  resolved.sort((a, b) => a.s - b.s || a.e - b.e);
  const masked = [...ctx.masked].sort((a, b) => a.start - b.start);
  const kept: SpanItem[] = [];
  let lastEnd = -1;
  for (const c of resolved) {
    const { s, e } = c;
    // Trimming numeric ends inward duplicated numbers ("a las 10:30h" → "alle 10:30 10:30h"): drop.
    if (tokens[s].numeric || tokens[e].numeric) {
      drop('numeric');
      continue;
    }
    if (sentenceOf[s] !== sentenceOf[e]) {
      drop('sentence');
      continue;
    }
    const start = tokens[s].start;
    const end = tokens[e].end;
    if (masked.some(m => m.start < end && m.end > start)) {
      drop('masked');
      continue;
    }
    if (s <= lastEnd) {
      drop('overlap');
      continue;
    }
    const source = text.slice(start, end);
    const t = c.translation.trim();
    if (!t) {
      drop('empty');
      continue;
    }
    if (/[\r\n]/.test(t)) {
      drop('newline');
      continue;
    }
    if (URLISH.test(t)) {
      drop('url');
      continue;
    }
    if (t.length > 4 * source.length + 20) {
      drop('length');
      continue;
    }
    const cognate = normPhrase(t) === normPhrase(source);
    if (cognate) stats.cognates++;
    kept.push({ startWord: s, endWord: e, start, end, source, translation: t, pos: c.pos, cognate });
    lastEnd = e;
  }
  stats.kept = kept.length;
  return { kept, stats };
}
