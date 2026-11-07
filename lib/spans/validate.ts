// Validator for the substring span format.
//
// ITEM LAYOUT (the model's reply, in text order):
//   {"i":[["source phrase","translation","pos"], …]}
// - source phrase: copied character for character from the text, within one sentence;
// - translation: what replaces it;
// - pos: one of POS_CODES (lib/pos.ts) or its long name (noun → n); `["n"]` is
//   accepted as `"n"`; a missing pos keeps the item with pos undefined; any
//   other value drops it ('pos').
// Extra trailing elements are ignored.

import { isPosCode, type PosCode } from '../pos';
import { createAligner, type AlignCtx, type AlignFail, type AlignHow } from './align';
import { buildProtection } from './protect';
import { capitalizeFirst, dedupePunctuation, leftDeterminer, type SourceLang, type TargetLang } from './seams';
import type { TextRange } from './tokenize';

export interface SpanItem extends TextRange {
  /** Absolute UTF-16 offsets into the original text (start/end from TextRange). */
  source: string;
  translation: string;
  /** Undefined when the model gave no pos. */
  pos?: PosCode;
  /** Translation equals the source: kept, but not swapped. */
  cognate: boolean;
  how: AlignHow;
}

export type DropReason =
  | 'shape' // not [string, string, …], or an empty source
  | 'posAsTranslation' // the translation is a POS tag ("n", "ADJ"): fields shifted
  | 'pos' // pos present but not a known code or name
  | AlignFail // align | ambiguous | boundary | masked | sentence | overlap
  | 'noWords' // the phrase has no word token (punctuation only)
  | 'numeric' // starts or ends on a number
  | 'protected' // a name or number in the source is missing from the translation
  | 'determiner' // the translation brings its own article, and the source one before the range is already swapped (see seams.ts)
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
  /** Kept items fixed at the seam (see seams.ts): punctuation trimmed, range extended over a determiner. */
  repaired: { punct: number; determiner: number };
}

export interface ValidateCtx extends AlignCtx {
  /** Both set → the determiner seam check runs; either missing → it is skipped. */
  sourceLang?: SourceLang;
  targetLang?: TargetLang;
}

export interface ValidationResult {
  /** Kept items sorted by start offset; never overlapping. */
  kept: SpanItem[];
  stats: ValidationStats;
}

const URLISH = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.)/iu;
// Uppercase tagset names are never translations.
const UPPER_TAG = /^(?:ADJ|ADV|NOUN|VERB|PRON|PREP|CONJ|DET|INTJ|PROPN|ADP|AUX|NUM|PART|SCONJ|CCONJ)$/;
// Lowercase tag words are real words ("verb", "expression"): suspicious only
// when the pos slot doesn't hold a valid code (fields shifted).
const LOWER_TAG = /^(?:adj|adjective|adv|adverb|noun|verb|pron|pronoun|prep|preposition|conj|conjunction|det|determiner|intj|interj|interjection|propn|adp|aux|expr|expression)$/i;
const POS_NAMES: Record<string, PosCode> = {
  noun: 'n', verb: 'v', adj: 'a', adjective: 'a', adv: 'r', adverb: 'r', pron: 'p', pronoun: 'p',
  det: 'd', determiner: 'd', article: 'd', prep: 's', preposition: 's', adp: 's', conj: 'c', conjunction: 'c',
  intj: 'i', interj: 'i', interjection: 'i', expr: 'x', expression: 'x', phrase: 'x', idiom: 'x',
};

function normPhrase(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase().replace(/[’ʼ‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

/** pos: a code, a long name (noun → n), or either wrapped as ["n"]. Missing → undefined; anything else → invalid. */
function readPos(raw: unknown): { pos?: PosCode; wrapped: boolean; invalid: boolean } {
  let p = raw;
  let wrapped = false;
  if (Array.isArray(p)) {
    wrapped = true;
    p = p[0];
  }
  if (p === undefined || p === null || p === '') return { wrapped, invalid: false };
  const code = typeof p === 'string' ? p.trim().toLowerCase() : '';
  const pos = isPosCode(code) ? code : POS_NAMES[code];
  return { pos, wrapped, invalid: !pos };
}

/** The translation is a POS tag rather than a translation (fields shifted or dropped). */
function looksLikePosTag(translation: string, source: string, rawPos: unknown, posValid: boolean, length: number): boolean {
  const t = translation.trim();
  if (normPhrase(t) === normPhrase(source)) return false;
  if (UPPER_TAG.test(t)) return true;
  if (!posValid && LOWER_TAG.test(t)) return true;
  // A bare POS code is a real word in some languages (Italian "a", "e"):
  // only suspicious when it stands where the pos should be.
  return isPosCode(t) && (length < 3 || t === (Array.isArray(rawPos) ? rawPos[0] : rawPos));
}

/**
 * Aligns and checks raw items. Pure; never throws. Per item: shape → POS tag in
 * the translation slot → pos code → in-order alignment (see align.ts; rejects
 * ambiguous hits, token cuts, masked ranges, sentence crossing, overlaps) →
 * word tokens → numeric endpoints → translation caps (empty, newline, URL/email,
 * > 4×source+20) → seams (see seams.ts): doubled punctuation trimmed from the
 * translation (empty after → 'empty'); with sourceLang and targetLang, a source
 * determiner left before a translation that has its own article extends the
 * range over it, or drops the item ('determiner') when another kept item holds
 * that word → protected names/numbers on the final range (see protect.ts) →
 * cognate (kept, not swapped). Repairs count in stats.repaired; a kept range
 * always slices the original text verbatim.
 */
export function validateItems(items: readonly unknown[], ctx: ValidateCtx): ValidationResult {
  const { text, tokens } = ctx;
  const aligner = createAligner(ctx);
  const stats: ValidationStats = {
    received: items.length, kept: 0, cognates: 0, posWrapped: 0,
    aligned: { exact: 0, case: 0, backtrack: 0, next: 0, ahead: 0 },
    dropped: {},
    repaired: { punct: 0, determiner: 0 },
  };
  const drop = (r: DropReason) => {
    stats.dropped[r] = (stats.dropped[r] ?? 0) + 1;
  };

  const range = ctx.range ?? { start: 0, end: text.length };
  const sentenceList = ctx.sentences?.length ? ctx.sentences : [range];
  const protection = buildProtection(text, tokens, sentenceList);
  const sentenceOf = (at: number): TextRange =>
    sentenceList.find(s => s.start <= at && at < s.end) ?? range;
  const langs = ctx.sourceLang && ctx.targetLang ? { sourceLang: ctx.sourceLang, targetLang: ctx.targetLang } : null;

  const kept: SpanItem[] = [];
  for (const it of items) {
    if (!Array.isArray(it) || typeof it[0] !== 'string' || typeof it[1] !== 'string' || !it[0].trim()) {
      drop('shape');
      continue;
    }
    const source: string = it[0];
    const translation: string = it[1];
    const { pos, wrapped, invalid } = readPos(it[2]);
    if (looksLikePosTag(translation, source, it[2], !!pos, it.length)) {
      drop('posAsTranslation');
      continue;
    }
    if (wrapped) stats.posWrapped++;
    if (invalid) {
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
    let src = text.slice(hit.start, hit.end);
    let t = translation.trim();
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
    const sentence = sentenceOf(hit.start);
    const punct = dedupePunctuation(text, hit, sentence, t);
    if (punct.changed) {
      t = punct.translation;
      if (!t) {
        drop('empty');
        continue;
      }
    }
    let start = hit.start;
    let toks = inside;
    let detFixed = false;
    const det = langs && leftDeterminer({ text, tokens, range: hit, sentence, translation: t, pos, ...langs });
    if (det) {
      const d = det.token;
      const taken = d.start < range.start || kept.some(k => k.start < d.end && k.end > d.start);
      if (taken || !det.extend) {
        drop('determiner');
        continue;
      }
      start = d.start;
      src = text.slice(start, hit.end);
      toks = [d, ...inside];
      if (det.initial) t = capitalizeFirst(t);
      detFixed = true;
    }
    const cognate = normPhrase(t) === normPhrase(src);
    if (!cognate && protection.lost(toks, t)) {
      drop('protected');
      continue;
    }
    if (cognate) stats.cognates++;
    if (punct.changed) stats.repaired.punct++;
    if (detFixed) stats.repaired.determiner++;
    aligner.occupy({ start, end: hit.end });
    kept.push({ start, end: hit.end, source: src, translation: t, pos, cognate, how: hit.how });
  }
  kept.sort((a, b) => a.start - b.start);
  stats.kept = kept.length;
  return { kept, stats };
}
