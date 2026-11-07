// Seam checks: what happens where a swapped range meets the source text around it.
//
// The renderer replaces text[start, end) with the translation and keeps
// everything else. Two seam errors pass the other checks and still render badly
// (learning #7, ebook prototype):
//
// 1. DOUBLED PUNCTUATION. The translation repeats punctuation the source already
//    has right outside the range: "Well, she said" + ["Well", "Bueno,"] renders
//    "Bueno,, she said". Repair: trim it from the translation. Offsets never
//    change, and the source punctuation that stays carries the same meaning.
// 2. A DETERMINER LEFT BEHIND. The model swaps the noun but its translation
//    brings its own article: "on the sofa" + ["sofa", "il divano"] renders
//    "on the il divano". Repair: extend the range over the determiner when that
//    word is free; drop the item when another kept item already swapped it.
//
// FALSE POSITIVES ARE WORSE THAN MISSES. A wrong repair corrupts a good item
// (it deletes source words or translated punctuation); a miss only leaves a
// visible doubling. So every rule below fires on a narrow, explicit pattern and
// gives up when anything is ambiguous. Each "never" below is a miss we accept.

import type { PosCode } from '../pos';
import type { TextRange, WordToken } from './tokenize';

export type SourceLang = 'en' | 'es';
export type TargetLang = 'en' | 'it' | 'es';

// ---------------------------------------------------------------------------
// 1. Doubled punctuation
// ---------------------------------------------------------------------------
//
// CLASSES. Quotes " “ ” „ ‟ « » ‹ › ' ‘ ’ ʼ are one class (the model often swaps
// quote styles: «hola» inside "…" still doubles). Dashes — – ― ‒ and a spaced
// "-" are one class. "." and "…" share one. , ; : ? ! ¿ ¡ ( ) [ ] are each
// their own class.
//
// LEADING. b = the last non-space character before the range in its sentence.
// When the source phrase does not itself start with punctuation and the
// translation starts with punctuation of b's class, strip that leading run
// (same-class characters and spaces). TRAILING is the mirror, with a = the first
// non-space character after the range. When the sentence has nothing before /
// after the range, the rest of the paragraph is looked at, but only for
// characters that cannot start / end a sentence on their own (an opening quote,
// ¿ ¡ ( [ before; , . … ; : ? ! ) ] or a closing quote after).
//
// GUARDS (each one turns a repair into a miss):
// - A quote b must be opening (« ‹ “ „ ‟ ‘, or " ' » › ” ’ with a space or an
//   opener before it); a quote a must be closing (the mirror). "said "go" now"
//   + ["now", "\"ora\""] has b = a closing quote and is left alone.
// - An apostrophe next to a letter is never stripped: trailing "un po'",
//   "dogs'" (elision, possessive), leading "'na", "'tis" (aphaeresis).
// - The translation must hold more characters of the class than the source
//   phrase does (the extra one is the double).
// - Quotes and brackets must stay balanced: after the strip, the translation's
//   quote parity and ( ) / [ ] difference must equal the source phrase's.
//   "un po'" inside quotes + ["un poco", "\"un po'\""] would lose only its
//   opening quote, so nothing is stripped.

const QUOTES = new Set(['"', '“', '”', '„', '‟', '«', '»', '‹', '›', "'", '‘', '’', 'ʼ']);
const APOSTROPHES = new Set(["'", '’', 'ʼ']);
const OPENING_QUOTES = new Set(['«', '‹', '“', '„', '‟', '‘']);
const CLOSING_QUOTES = new Set(['»', '›', '”', '’']);
const DASHES = new Set(['—', '–', '―', '‒']);
const SINGLE = new Set([',', ';', ':', '?', '!', '¿', '¡', '(', ')', '[', ']']);
const WORDCHAR = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const SPACE = /\s/u;
// Characters before an opening quote / after a closing quote, besides space.
const OPENERS = new Set(['¿', '¡', '(', '[', '—', '–', '«', '“', '‘', '‹', '„']);
const CLOSERS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '…', '—', '–', '»', '”', '’', '›']);
// Paragraph fallback: only characters that need something on their other side.
const LEAD_FALLBACK = new Set(['¿', '¡', '(', '[']);
const TRAIL_FALLBACK = new Set([',', '.', '…', ';', ':', '?', '!', ')', ']']);

type PClass = string;

/** Class of s[k], reading neighbours for the spaced-hyphen rule. Null: not punctuation we handle. */
function classAt(s: string, k: number): PClass | null {
  const ch = s[k];
  if (QUOTES.has(ch)) return 'q';
  if (DASHES.has(ch)) return 'd';
  if (ch === '-') {
    const before = k === 0 || SPACE.test(s[k - 1]);
    const after = k === s.length - 1 || SPACE.test(s[k + 1]);
    return before && after ? 'd' : null;
  }
  if (ch === '.' || ch === '…') return '.';
  if (SINGLE.has(ch)) return ch;
  return null;
}

function countClass(s: string, cls: PClass): number {
  let n = 0;
  for (let k = 0; k < s.length; k++) if (classAt(s, k) === cls) n++;
  return n;
}

/** Quote characters that are not apostrophes inside or at the edge of a word. */
function quoteParity(s: string): number {
  let n = 0;
  for (let k = 0; k < s.length; k++) {
    if (!QUOTES.has(s[k])) continue;
    if (APOSTROPHES.has(s[k]) && (LETTER.test(s[k - 1] ?? '') || LETTER.test(s[k + 1] ?? ''))) continue;
    n++;
  }
  return n % 2;
}
const diff = (s: string, open: string, close: string) => s.split(open).length - s.split(close).length;
const balanced = (a: string, b: string) =>
  quoteParity(a) === quoteParity(b) && diff(a, '(', ')') === diff(b, '(', ')') && diff(a, '[', ']') === diff(b, '[', ']');

/** Index of the last non-space character in [lo, hi), or -1. */
function lastNonSpace(text: string, lo: number, hi: number): number {
  for (let k = hi - 1; k >= lo; k--) if (!SPACE.test(text[k])) return k;
  return -1;
}
function firstNonSpace(text: string, lo: number, hi: number): number {
  for (let k = lo; k < hi; k++) if (!SPACE.test(text[k])) return k;
  return -1;
}
function paragraphStart(text: string, at: number): number {
  const k = text.lastIndexOf('\n', at - 1);
  return k < 0 ? 0 : k + 1;
}
function paragraphEnd(text: string, at: number): number {
  const k = text.indexOf('\n', at);
  return k < 0 ? text.length : k;
}

/** The source character that the translation's first character could double, with its class. */
function charBefore(text: string, range: TextRange, sentence: TextRange): PClass | null {
  let k = lastNonSpace(text, Math.min(sentence.start, range.start), range.start);
  let fallback = false;
  if (k < 0) {
    k = lastNonSpace(text, paragraphStart(text, range.start), range.start);
    fallback = true;
  }
  if (k < 0) return null;
  const ch = text[k];
  const cls = classAt(text, k);
  if (!cls) return null;
  if (cls === 'q') {
    const prev = text[k - 1];
    const opening = OPENING_QUOTES.has(ch) || prev === undefined || SPACE.test(prev) || OPENERS.has(prev);
    if (!opening || (APOSTROPHES.has(ch) && LETTER.test(prev ?? ''))) return null;
  }
  if (fallback && !(LEAD_FALLBACK.has(ch) || (cls === 'q' && OPENING_QUOTES.has(ch)))) return null;
  return cls;
}

function charAfter(text: string, range: TextRange, sentence: TextRange): PClass | null {
  let k = firstNonSpace(text, range.end, Math.max(sentence.end, range.end));
  let fallback = false;
  if (k < 0) {
    k = firstNonSpace(text, range.end, paragraphEnd(text, range.end));
    fallback = true;
  }
  if (k < 0) return null;
  const ch = text[k];
  const cls = classAt(text, k);
  if (!cls) return null;
  if (cls === 'q') {
    const next = text[k + 1];
    const closing = CLOSING_QUOTES.has(ch) || next === undefined || SPACE.test(next) || CLOSERS.has(next);
    if (!closing) return null;
  }
  if (fallback && !(TRAIL_FALLBACK.has(ch) || (cls === 'q' && CLOSING_QUOTES.has(ch)))) return null;
  return cls;
}

/** Length of the leading run of `cls` characters and spaces (at least one `cls`), or 0. */
function leadingRun(t: string, cls: PClass): number {
  let k = 0;
  let hits = 0;
  while (k < t.length) {
    if (SPACE.test(t[k])) {
      k++;
      continue;
    }
    if (classAt(t, k) !== cls) break;
    if (APOSTROPHES.has(t[k]) && LETTER.test(t[k + 1] ?? '')) break; // 'na, 'tis
    hits++;
    k++;
  }
  return hits ? k : 0;
}
function trailingRun(t: string, cls: PClass): number {
  let k = t.length;
  let hits = 0;
  while (k > 0) {
    if (SPACE.test(t[k - 1])) {
      k--;
      continue;
    }
    if (classAt(t, k - 1) !== cls) break;
    if (APOSTROPHES.has(t[k - 1]) && LETTER.test(t[k - 2] ?? '')) break; // un po', dogs'
    hits++;
    k--;
  }
  return hits ? t.length - k : 0;
}

const startsWithPunct = (s: string) => s.length > 0 && !WORDCHAR.test(s[0]) && !SPACE.test(s[0]);
const endsWithPunct = (s: string) => s.length > 0 && !WORDCHAR.test(s[s.length - 1]) && !SPACE.test(s[s.length - 1]);

/**
 * Trims punctuation from the translation's edges when the source already has
 * it right outside the range (see the rules above). `range` and `sentence` are
 * absolute offsets into `text`; `translation` is already trimmed. Returns the
 * repaired translation (possibly empty) and whether it changed.
 */
export function dedupePunctuation(
  text: string, range: TextRange, sentence: TextRange, translation: string,
): { translation: string; changed: boolean } {
  const source = text.slice(range.start, range.end);
  let t = translation;
  const before = startsWithPunct(source) ? null : charBefore(text, range, sentence);
  if (before) {
    const n = leadingRun(t, before);
    if (n && countClass(t, before) > countClass(source, before)) t = t.slice(n);
  }
  const after = endsWithPunct(source) ? null : charAfter(text, range, sentence);
  if (after) {
    const n = trailingRun(t, after);
    if (n && countClass(t, after) > countClass(source, after)) t = t.slice(0, t.length - n);
  }
  t = t.trim();
  if (t === translation) return { translation, changed: false };
  if (!balanced(t, source)) return { translation, changed: false };
  return { translation: t, changed: true };
}

// ---------------------------------------------------------------------------
// 2. A determiner left before the range
// ---------------------------------------------------------------------------
//
// FIRES WHEN all of these hold:
// - p, the word token right before the range, is separated from it by spaces
//   only, sits in the same sentence and is a SOURCE determiner below;
// - p is lowercase, or capitalised as the first word of its sentence. A
//   capitalised p mid-sentence is part of a name or a label ("en La Paz",
//   "The Hague", "Plan A") and is left alone;
// - the range's own first word is not a source determiner ("this ⟨the right
//   way⟩": the translation's article belongs to "the", not to "this");
// - for forms that are also pronouns, the item's pos is n or a (a noun phrase).
//   es la/las/los are object clitics ("Juan la ⟨vio⟩" → "l'ha vista" starts with
//   an Italian l'); demonstratives and nuestro/vuestro stand alone ("compró
//   esos ⟨la semana pasada⟩", "he bought these ⟨la settimana scorsa⟩"); en
//   "his" is a pronoun ("it was his"). A missing pos is not enough for these;
// - the translation's first word (nothing but spaces/punctuation before it)
//   is a TARGET article, or one of the pair-specific forms below.
// Then the range is extended over p when p is free, else the item is dropped.
//
// CONTRACTIONS es del / al ("de" + "el", "a" + "el"). They hold a preposition
// as well as an article, so extending over them is only right when the
// translation carries both:
// - it: an articulated preposition of the same preposition (del → del, dello,
//   della, dell', dei, degli, delle; al → al, allo, alla, all', ai, agli,
//   alle). "La tapa del ⟨del libro⟩" → extend.
// - en: of / from + a determiner for del, to / at / into + a determiner for
//   al. "el centro del ⟨of the town⟩" → extend.
// - A bare article ("del ⟨il libro⟩") doubles the article but drops "de":
//   extending would render "La tapa il libro". The item is DROPPED. (The
//   personal "a" — "vio al ⟨il bambino⟩" — would be right to extend, but it
//   cannot be told apart from "fue al ⟨il mercato⟩" here, so it drops too.)
// English "of the ⟨la casa⟩" is fine to extend over "the": "of" stays English
// and "la casa" brings the article. The doubled preposition "of the ⟨della
// casa⟩" is not handled (a miss: extending over "the" leaves "of della").
//
// "un" / "una" are articles and numerals in Spanish; both readings render the
// same when the translation starts with un / una / a, so they are treated as
// determiners. "un ⟨one year⟩" is not caught (one is not a target article).

const SOURCE_DETERMINERS: Readonly<Record<SourceLang, ReadonlySet<string>>> = {
  // Excluded: that (conjunction / relative), her (object pronoun).
  en: new Set(['the', 'a', 'an', 'this', 'these', 'those', 'my', 'your', 'his', 'its', 'our', 'their']),
  // Excluded: lo (clitic / neuter article), le, les (clitics).
  es: new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'aquellos', 'aquellas',
    'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
    'vuestro', 'vuestra', 'vuestros', 'vuestras', 'del', 'al',
  ]),
};

/** Source forms that are also pronouns: a determiner only when the item's pos is n or a. */
const PRONOUN_LOOKALIKES: Readonly<Record<SourceLang, ReadonlySet<string>>> = {
  en: new Set(['this', 'these', 'those', 'his']),
  es: new Set([
    'la', 'las', 'los',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'aquellos', 'aquellas',
    'nuestro', 'nuestra', 'nuestros', 'nuestras', 'vuestro', 'vuestra', 'vuestros', 'vuestras',
  ]),
};

const TARGET_ARTICLES: Readonly<Record<TargetLang, ReadonlySet<string>>> = {
  // Possessives follow an article in Italian (il mio), so the article is what is checked.
  it: new Set([
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
    'questo', 'questa', 'questi', 'queste', 'quel', 'quello', 'quella', 'quei', 'quegli', 'quelle',
  ]),
  en: new Set(['the', 'a', 'an', 'this', 'these', 'those', 'my', 'your', 'his', 'its', 'our', 'their']),
  es: new Set([...SOURCE_DETERMINERS.es].filter(w => w !== 'del' && w !== 'al')),
};
/** Elided Italian articles and demonstratives: l'acqua, un'amica, quest'anno, quell'uomo. */
const TARGET_ELIDED: Readonly<Record<TargetLang, readonly string[]>> = {
  it: ["l'", "un'", "quest'", "quell'"],
  en: [],
  es: [],
};

const POSSESSIVE_SOURCE = new Set([
  'my', 'your', 'his', 'its', 'our', 'their',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'vuestro', 'vuestra', 'vuestros', 'vuestras',
]);
// Italian possessive without an article: family nouns ("mia madre"). Not "loro" (also "they").
const IT_POSSESSIVES = new Set([
  'mio', 'mia', 'miei', 'mie', 'tuo', 'tua', 'tuoi', 'tue', 'suo', 'sua', 'suoi', 'sue',
  'nostro', 'nostra', 'nostri', 'nostre', 'vostro', 'vostra', 'vostri', 'vostre',
]);

/** Pair-specific forms that also count as the translation's own determiner for this p. */
function pairExtra(p: string, target: TargetLang, w: string): boolean {
  if (target === 'it') {
    if (POSSESSIVE_SOURCE.has(p) && IT_POSSESSIVES.has(w)) return true;
    if ((p === 'unos' || p === 'unas') && ['dei', 'degli', 'delle', 'alcuni', 'alcune'].includes(w)) return true;
  }
  if (target === 'en') {
    if ((p === 'su' || p === 'sus') && w === 'her') return true; // su casa → her house
    if (['ese', 'esa', 'aquel', 'aquella'].includes(p) && w === 'that') return true;
    if ((p === 'unos' || p === 'unas') && w === 'some') return true;
  }
  return false;
}

const IT_ARTICULATED: Readonly<Record<'del' | 'al', { words: ReadonlySet<string>; elided: string }>> = {
  del: { words: new Set(['del', 'dello', 'della', 'dei', 'degli', 'delle']), elided: "dell'" },
  al: { words: new Set(['al', 'allo', 'alla', 'ai', 'agli', 'alle']), elided: "all'" },
};
const EN_PREPOSITIONS: Readonly<Record<'del' | 'al', ReadonlySet<string>>> = {
  del: new Set(['of', 'from']),
  al: new Set(['to', 'at', 'into']),
};
const EN_AFTER_PREPOSITION = new Set([...TARGET_ARTICLES.en, 'her', 'that']);

const straight = (s: string) => s.normalize('NFC').toLocaleLowerCase().replace(/[’ʼ‘]/g, "'");

/** The translation's first two words, lowercase with straight apostrophes; [] when it starts with a digit. */
function leadingWords(t: string): string[] {
  const m = /^[^\p{L}\p{N}]*/u.exec(t);
  const rest = t.slice(m ? m[0].length : 0);
  if (!rest || !/^\p{L}/u.test(rest)) return [];
  const words = rest.match(/[\p{L}\p{M}]+(?:['’ʼ][\p{L}\p{M}]*)?/gu) ?? [];
  return words.slice(0, 2).map(straight);
}

function isTargetArticle(w: string, target: TargetLang): boolean {
  return TARGET_ARTICLES[target].has(w) || TARGET_ELIDED[target].some(e => w.startsWith(e) && w.length > e.length);
}

export interface LeftDeterminerArgs {
  text: string;
  /** Word tokens, absolute offsets, in order. */
  tokens: readonly WordToken[];
  range: TextRange;
  sentence: TextRange;
  translation: string;
  pos?: PosCode;
  sourceLang: SourceLang;
  targetLang: TargetLang;
}

export interface LeftDeterminer {
  /** The source determiner right before the range. */
  token: WordToken;
  /** false: extending would lose meaning (del/al before a bare article) — drop instead. */
  extend: boolean;
  /** p was capitalised as the first word of its sentence. */
  initial: boolean;
}

/** The source determiner the translation doubles, or null (see the rules above). */
export function leftDeterminer(a: LeftDeterminerArgs): LeftDeterminer | null {
  const { text, tokens, range, sentence, sourceLang, targetLang } = a;
  let k = tokens.findIndex(t => t.start >= range.start);
  if (k < 0) k = tokens.length;
  const p = tokens[k - 1];
  const first = tokens[k];
  if (!p || p.start < sentence.start || !/^\s+$/u.test(text.slice(p.end, range.start))) return null;
  const w = straight(p.text);
  const dets = SOURCE_DETERMINERS[sourceLang];
  if (!dets.has(w)) return null;
  if (first && first.start < range.end && dets.has(straight(first.text))) return null;
  if (PRONOUN_LOOKALIKES[sourceLang].has(w) && a.pos !== 'n' && a.pos !== 'a') return null;
  const initial = !WORDCHAR.test(text.slice(sentence.start, p.start));
  const capital = /^\p{Lu}/u.test(p.text);
  if (capital && !initial) return null;

  const [w1, w2] = leadingWords(a.translation);
  if (!w1) return null;
  if (w === 'del' || w === 'al') {
    if (targetLang === 'it') {
      const art = IT_ARTICULATED[w];
      if (art.words.has(w1) || (w1.startsWith(art.elided) && w1.length > art.elided.length)) return { token: p, extend: true, initial: capital };
    } else if (targetLang === 'en') {
      if (EN_PREPOSITIONS[w].has(w1) && w2 && EN_AFTER_PREPOSITION.has(w2)) return { token: p, extend: true, initial: capital };
    }
    return isTargetArticle(w1, targetLang) ? { token: p, extend: false, initial: capital } : null;
  }
  if (isTargetArticle(w1, targetLang) || pairExtra(w, targetLang, w1)) return { token: p, extend: true, initial: capital };
  return null;
}

/** Uppercases the translation's first letter (l'acqua → L'acqua). */
export function capitalizeFirst(t: string): string {
  const k = t.search(/\p{L}/u);
  return k < 0 ? t : t.slice(0, k) + t[k].toLocaleUpperCase() + t.slice(k + 1);
}
