// Validator for the model's span items.
//
// TUPLE LAYOUT (indices are chunk-local word indices, ranges INCLUSIVE):
//   single word:  [s, s, anchor, translation, pos]                 (5 elements)
//   multi-word:   [s, e, startAnchor, endAnchor, translation, pos] (6 elements)
// `anchor`/`startAnchor` is word s copied exactly; `endAnchor` is word e.
// The element count is the discriminator. A 6-tuple with s == e is accepted
// (endAnchor is then checked against word s). A 5-tuple with e > s carries no
// end anchor, so its end can't be verified and it is dropped ('endAnchor').
// A non-string or unknown pos keeps the item with `pos: undefined`.

import { isPosCode, type PosCode } from '../pos';
import type { TextRange, WordToken } from './tokenize';

export interface SpanItem {
  /** Chunk-local inclusive word indices. */
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
  | 'shape' | 'bounds' | 'anchor' | 'endAnchor' | 'numeric' | 'sentence' | 'overlap'
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
export function anchorMatches(anchor: string, token: string, side: 'start' | 'end' = 'start'): boolean {
  const a = normWord(anchor);
  const t = normWord(token);
  if (!a) return false;
  if (a === t) return true;
  if (a.length < 2) return false;
  if (side === 'start') return t.startsWith(a) && /^['-]/.test(t.slice(a.length));
  return t.endsWith(a) && /['-]$/.test(t.slice(0, t.length - a.length));
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

function readTuple(it: unknown): Tuple | null {
  if (!Array.isArray(it) || (it.length !== 5 && it.length !== 6)) return null;
  const [s, e, anchor] = it;
  const six = it.length === 6;
  const endAnchor: unknown = six ? it[3] : undefined;
  const translation: unknown = it[six ? 4 : 3];
  const pos: unknown = it[six ? 5 : 4];
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  if (typeof anchor !== 'string' || typeof translation !== 'string') return null;
  if (six && typeof endAnchor !== 'string') return null;
  return {
    s: s as number,
    e: e as number,
    anchor,
    endAnchor: endAnchor as string | undefined,
    translation,
    pos: isPosCode(pos) ? pos : undefined,
  };
}

type EndState = 'inclusive' | 'exclusive' | 'both' | 'fixed';

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
 * end, else e+1, else ±2; twins → drop) → bounds → sort → numeric endpoints →
 * sentence crossing → overlap → translation checks → cognate.
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
    if (startAt(s)) {
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
      const atE = endAt(e);
      const atPrev = endAt(e - 1);
      if (atE && atPrev) end = 'both';
      else if (atE) end = 'inclusive';
      else if (atPrev) {
        end = 'exclusive';
        e -= 1;
      } else {
        let moved = 0;
        if (endAt(e + 1)) moved = 1;
        else {
          const lo = endAt(e - 2);
          const hi = endAt(e + 2);
          if (lo !== hi) moved = lo ? -2 : 2;
        }
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
  for (const c of cands) {
    if (c.end !== 'both') continue;
    if (stats.exclusiveMode) {
      c.e -= 1;
      stats.exclusiveEnds++;
    } else if (c.e > c.s) stats.endAnchorExact++;
  }

  cands.sort((a, b) => a.s - b.s || a.e - b.e);
  const kept: SpanItem[] = [];
  let lastEnd = -1;
  for (const c of cands) {
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
    if (s <= lastEnd) {
      drop('overlap');
      continue;
    }
    const start = tokens[s].start;
    const end = tokens[e].end;
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
