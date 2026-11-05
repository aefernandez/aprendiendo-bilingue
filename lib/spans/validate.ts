// Validator for the substring span format.
//
// ITEM LAYOUT (the model's reply, in text order):
//   {"i":[["source phrase","translation","pos"], …]}
// - source phrase: copied character for character from the text, within one sentence;
// - translation: what replaces it;
// - pos: one of POS_CODES (lib/pos.ts). `["n"]` is accepted as `"n"`.
// Extra trailing elements are ignored.

import { isPosCode, type PosCode } from '../pos';
import { createAligner, type AlignCtx, type AlignFail, type AlignHow } from './align';
import type { TextRange, WordToken } from './tokenize';

export interface SpanItem extends TextRange {
  /** Absolute UTF-16 offsets into the original text (start/end from TextRange). */
  source: string;
  translation: string;
  pos: PosCode;
  /** Translation equals the source: kept, but not swapped. */
  cognate: boolean;
  how: AlignHow;
}

export type DropReason =
  | 'shape' // not [string, string, …], or an empty source
  | 'posAsTranslation' // the translation is a POS tag ("n", "ADJ"): fields shifted
  | 'pos' // pos missing or not a known code
  | AlignFail // align | boundary | masked | sentence | overlap
  | 'noWords' // the phrase has no word token (punctuation only)
  | 'numeric' // starts or ends on a number
  | 'protected' // a name or number in the source is missing from the translation
  | 'empty' | 'newline' | 'url' | 'length';

export interface ValidationStats {
  received: number;
  kept: number;
  cognates: number;
  /** Items whose pos came wrapped as ["n"]. */
  posWrapped: number;
  /** How kept-or-later-dropped items were aligned. */
  aligned: Record<AlignHow, number>;
  dropped: Partial<Record<DropReason, number>>;
}

export type ValidateCtx = AlignCtx;

export interface ValidationResult {
  /** Kept items sorted by start offset; never overlapping. */
  kept: SpanItem[];
  stats: ValidationStats;
}

const URLISH = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.)/iu;
const POS_TAG = /^(?:adj|adjective|adv|adverb|noun|verb|pron|pronoun|prep|preposition|conj|conjunction|det|determiner|intj|interj|interjection|propn|adp|aux|expr|expression)$/i;
// English capitalises day and month names; they are translated, not names.
const CALENDAR_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);
const OPENERS = /[«"“‘'¿¡(\[—–-]\s*$/u;

function normPhrase(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase().replace(/[’ʼ‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

function readPos(raw: unknown): { pos?: PosCode; wrapped: boolean } {
  let p = raw;
  let wrapped = false;
  if (Array.isArray(p)) {
    wrapped = true;
    p = p[0];
  }
  const code = typeof p === 'string' ? p.trim().toLowerCase() : undefined;
  return { pos: isPosCode(code) ? code : undefined, wrapped };
}

/** The translation is a POS tag rather than a translation (fields shifted or dropped). */
function looksLikePosTag(translation: string, source: string, rawPos: unknown, length: number): boolean {
  const t = translation.trim();
  if (normPhrase(t) === normPhrase(source)) return false;
  if (POS_TAG.test(t)) return true;
  // A bare POS code is a real word in some languages (Italian "a", "e"):
  // only suspicious when it stands where the pos should be.
  return isPosCode(t) && (length < 3 || t === (Array.isArray(rawPos) ? rawPos[0] : rawPos));
}

/**
 * Protected tokens inside [start, end): numbers, and capitalised words that
 * are not sentence-initial, don't follow an opening quote/¿/¡, and aren't
 * "I" or an English day/month name (so: names).
 * Each must survive in the translation: a number by its leading digits, a name verbatim.
 */
function lostProtected(
  text: string,
  inside: readonly WordToken[],
  firstOfSentence: ReadonlySet<number>,
  translation: string,
): boolean {
  const straight = (x: string) => x.normalize('NFC').replace(/[’ʼ‘]/g, "'");
  const t = straight(translation);
  for (const tok of inside) {
    if (tok.numeric) {
      const digits = /^\p{Nd}+/u.exec(tok.text)?.[0] ?? tok.text.replace(/\D/g, '');
      if (digits && !t.includes(digits)) return true;
      continue;
    }
    if (!/^\p{Lu}/u.test(tok.text) || firstOfSentence.has(tok.start)) continue;
    if (tok.text === 'I' || CALENDAR_WORDS.has(tok.text.toLowerCase())) continue; // English pronoun, days, months
    if (OPENERS.test(text.slice(Math.max(0, tok.start - 3), tok.start))) continue;
    if (!t.includes(straight(tok.text))) return true;
  }
  return false;
}

/**
 * Aligns and checks raw items. Pure; never throws. Per item: shape → POS tag in
 * the translation slot → pos code → in-order alignment (see align.ts; rejects
 * token cuts, masked ranges, sentence crossing, overlaps) → word tokens →
 * numeric endpoints → translation caps (empty, newline, URL/email, > 4×source+20)
 * → protected names/numbers → cognate (kept, not swapped).
 */
export function validateItems(items: readonly unknown[], ctx: ValidateCtx): ValidationResult {
  const { text, tokens } = ctx;
  const aligner = createAligner(ctx);
  const stats: ValidationStats = {
    received: items.length, kept: 0, cognates: 0, posWrapped: 0,
    aligned: { exact: 0, case: 0, backtrack: 0, jump: 0 },
    dropped: {},
  };
  const drop = (r: DropReason) => {
    stats.dropped[r] = (stats.dropped[r] ?? 0) + 1;
  };

  const sentenceStarts = (ctx.sentences ?? []).map(s => s.start);
  const firstOfSentence = new Set<number>();
  {
    const starts = [...sentenceStarts, ctx.range?.start ?? 0].sort((a, b) => a - b);
    let k = 0;
    for (const s of starts) {
      while (k < tokens.length && tokens[k].start < s) k++;
      if (k < tokens.length) firstOfSentence.add(tokens[k].start);
    }
  }

  const kept: SpanItem[] = [];
  for (const it of items) {
    if (!Array.isArray(it) || typeof it[0] !== 'string' || typeof it[1] !== 'string' || !it[0].trim()) {
      drop('shape');
      continue;
    }
    const source: string = it[0];
    const translation: string = it[1];
    if (looksLikePosTag(translation, source, it[2], it.length)) {
      drop('posAsTranslation');
      continue;
    }
    const { pos, wrapped } = readPos(it[2]);
    if (wrapped) stats.posWrapped++;
    if (!pos) {
      drop('pos');
      continue;
    }

    const hit = aligner.align(source);
    if ('fail' in hit) {
      drop(hit.fail);
      continue;
    }
    stats.aligned[hit.how]++;
    const inside = tokens.filter(t => t.start >= hit.start && t.end <= hit.end);
    if (!inside.length) {
      drop('noWords');
      continue;
    }
    if (inside[0].numeric || inside[inside.length - 1].numeric) {
      drop('numeric');
      continue;
    }
    const src = text.slice(hit.start, hit.end);
    const t = translation.trim();
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
    if (t.length > 4 * src.length + 20) {
      drop('length');
      continue;
    }
    const cognate = normPhrase(t) === normPhrase(src);
    if (!cognate && lostProtected(text, inside, firstOfSentence, t)) {
      drop('protected');
      continue;
    }
    if (cognate) stats.cognates++;
    aligner.occupy(hit);
    kept.push({ start: hit.start, end: hit.end, source: src, translation: t, pos, cognate, how: hit.how });
  }
  kept.sort((a, b) => a.start - b.start);
  stats.kept = kept.length;
  return { kept, stats };
}
