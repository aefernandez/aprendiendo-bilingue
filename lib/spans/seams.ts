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
//   or tabs only (no line break), sits in the same sentence and is a SOURCE
//   determiner below;
// - p is lowercase, or capitalised as the first word of its sentence. A
//   capitalised p mid-sentence is part of a name or a label ("en La Paz",
//   "The Hague", "Plan A") and is left alone. So is a sentence-initial one
//   followed by a capitalised word ("El Salvador es…", "The Hague is…");
// - the range's own first word is not a source determiner ("this ⟨the right
//   way⟩": the translation's article belongs to "the", not to "this");
// - for forms that are also pronouns, the item's pos is n or a (a noun phrase).
//   es la/las/los are object clitics ("Juan la ⟨vio⟩" → "l'ha vista" starts with
//   an Italian l'); demonstratives and nuestro/vuestro stand alone ("compró
//   esos ⟨la semana pasada⟩", "he bought these ⟨la settimana scorsa⟩"); en
//   "his" is a pronoun ("it was his"). A missing pos is not enough for these;
// - the translation's first word (nothing but spaces/punctuation before it)
//   is a TARGET determiner; Italian lo/la/le/gli/l', which are also object
//   clitics ("the ⟨lo sapeva⟩"), count only when the item's pos is n or a.
// Then, when the translation's determiner is the same KIND as p (see below),
// the range is extended over p when p is free, else the item is dropped. A
// different kind is dropped too, and so is a p that follows a predeterminer
// ("all the", "todos los", "what a"; see PREDETERMINERS).
//
// CONTRACTIONS es del / al ("de" + "el", "a" + "el"). They hold a preposition
// as well as an article, so extending over them is only right when the
// translation carries both:
// - it: an articulated preposition of the same preposition (del → del, dello,
//   della, dell', dei, degli, delle, or dal… since "de" is also "from"; al →
//   al, allo, alla, all', ai, agli, alle). "La tapa del ⟨del libro⟩" → extend.
// - en: of / from / about + "the" for del, to / at / into +
//   "the" for al (del / al hold "el", so only a definite article matches).
//   "el centro del ⟨of the town⟩" → extend; "del ⟨of her father⟩" is left alone.
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

type DetKind = 'definite' | 'indefinite' | 'demonstrative' | 'possessive';

/** Word → kind, from space-separated word lists (kept as data, one line per kind). */
function byKind(lists: Partial<Record<DetKind, string>>): ReadonlyMap<string, DetKind> {
  return new Map(Object.entries(lists).flatMap(([kind, words]) => words.split(' ').map(w => [w, kind as DetKind] as const)));
}

const SOURCE_DETERMINERS: Readonly<Record<SourceLang, ReadonlyMap<string, DetKind>>> = {
  // Excluded: that (conjunction / relative), her (object pronoun).
  en: byKind({
    definite: 'the',
    indefinite: 'a an',
    demonstrative: 'this these those',
    possessive: 'my your his its our their',
  }),
  // Excluded: lo (clitic / neuter article), le, les (clitics). del / al are
  // contractions (see above) and are matched separately before the kind check.
  es: byKind({
    definite: 'el la los las del al',
    indefinite: 'un una unos unas',
    demonstrative: 'este esta estos estas ese esa esos esas aquel aquella aquellos aquellas',
    possessive: 'mi mis tu tus su sus nuestro nuestra nuestros nuestras vuestro vuestra vuestros vuestras',
  }),
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

// KIND MATCH. The translation's determiner must be the same kind as p, or the
// item is DROPPED: extending "su ⟨the house⟩" would render "the house" and
// silently lose the possessive, "este ⟨the book⟩" the demonstrative, "the ⟨un
// cane⟩" the definiteness. A learner cannot see that; a doubled "su the house"
// at least looks wrong, and a drop leaves the source as written. The kinds are
// coarse on purpose (no person / number / proximity check): "su ⟨her house⟩"
// and "ese ⟨quel libro⟩" extend. Correct translations that change the kind
// ("se lavó las ⟨his hands⟩", "el ⟨quello che⟩ llega") drop: an accepted miss.
//
// Target words that are only safe after a matching p ("that" is also a
// conjunction, "her" an object pronoun, "some" a quantifier) are safe here
// because the kind must match p's.
const TARGET_DETERMINERS: Readonly<Record<TargetLang, ReadonlyMap<string, DetKind>>> = {
  it: byKind({
    definite: 'il lo la i gli le',
    indefinite: 'un uno una dei degli delle alcuni alcune',
    demonstrative: 'questo questa questi queste quel quello quella quei quegli quelle',
    // Bare possessive: family nouns ("mia madre"). Not "loro" (also "they"): it counts only after an article.
    possessive: 'mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri nostre vostro vostra vostri vostre',
  }),
  en: byKind({
    definite: 'the',
    indefinite: 'a an some',
    demonstrative: 'this these those that',
    possessive: 'my your his her its our their',
  }),
  es: byKind({
    definite: 'el la los las',
    indefinite: 'un una unos unas',
    demonstrative: 'este esta estos estas ese esa esos esas aquel aquella aquellos aquellas',
    possessive: 'mi mis tu tus su sus nuestro nuestra nuestros nuestras vuestro vuestra vuestros vuestras',
  }),
};
/** Elided Italian articles and demonstratives: l'acqua, un'amica, quest'anno, quell'uomo. */
const TARGET_ELIDED: Readonly<Record<TargetLang, readonly (readonly [string, DetKind])[]>> = {
  it: [["l'", 'definite'], ["un'", 'indefinite'], ["quest'", 'demonstrative'], ["quell'", 'demonstrative']],
  en: [],
  es: [],
};
/** Possessives that follow an article: "la mia casa", "il loro cane" count as possessive. */
const POSSESSIVE_AFTER_ARTICLE: Readonly<Record<TargetLang, ReadonlySet<string>>> = {
  it: new Set([...TARGET_DETERMINERS.it].filter(([, k]) => k === 'possessive').map(([w]) => w).concat('loro')),
  en: new Set(),
  es: new Set(),
};

// Spanish "de" is both "of" (di) and "from" (da): "salió del ⟨dal cinema⟩".
const IT_ARTICULATED: Readonly<Record<'del' | 'al', readonly string[]>> = {
  del: ['del', 'dello', 'della', "dell'", 'dei', 'degli', 'delle', 'dal', 'dallo', 'dalla', "dall'", 'dai', 'dagli', 'dalle'],
  al: ['al', 'allo', 'alla', "all'", 'ai', 'agli', 'alle'],
};
const EN_PREPOSITIONS: Readonly<Record<'del' | 'al', ReadonlySet<string>>> = {
  del: new Set(['of', 'from', 'about']),
  al: new Set(['to', 'at', 'into']),
};
/**
 * Words that sit before a determiner and belong to it ("all the children",
 * "todos los niños", "what a day"). Extending over the determiner alone would
 * strand them before the translation's article ("All ⟨i bambini⟩", "todos
 * ⟨the children⟩"), so the item is dropped instead.
 */
const PREDETERMINERS: Readonly<Record<SourceLang, ReadonlySet<string>>> = {
  en: new Set(['all', 'both', 'half', 'such', 'what', 'quite', 'rather', 'many', 'twice', 'double']),
  es: new Set(['todo', 'toda', 'todos', 'todas']),
};

/** Target determiners that are also another word class (conjunction, pronoun, quantifier): a kind mismatch is a no-op, not a drop. */
const AMBIGUOUS_TARGET: Readonly<Record<TargetLang, ReadonlySet<string>>> = {
  it: new Set(),
  en: new Set(['that', 'her', 'some']),
  es: new Set(),
};
/**
 * Italian articles that are also object clitics: "the ⟨lo sapeva⟩" (pos v) is a
 * verb phrase, not "the" + a noun. Like the source look-alikes, they count only
 * when the item's pos is n or a.
 */
const TARGET_CLITIC_LOOKALIKES: Readonly<Record<TargetLang, ReadonlySet<string>>> = {
  it: new Set(['lo', 'la', 'le', 'gli', "l'"]),
  en: new Set(),
  es: new Set(['la', 'las', 'los']),
};


const straight = (s: string) => s.normalize('NFC').toLocaleLowerCase().replace(/[’ʼ‘]/g, "'");

/** The translation's first two words, lowercase with straight apostrophes; [] when it starts with a digit. */
function leadingWords(t: string): string[] {
  const m = /^[^\p{L}\p{N}]*/u.exec(t);
  const rest = t.slice(m ? m[0].length : 0);
  if (!rest || !/^\p{L}/u.test(rest)) return [];
  const words = rest.match(/[\p{L}\p{M}]+(?:['’ʼ][\p{L}\p{M}]*)?/gu) ?? [];
  return words.slice(0, 2).map(straight);
}

/** Kind of the determiner the translation starts with (w1, w2: its first two words), or null. */
function targetKind(w1: string, w2: string | undefined, target: TargetLang): DetKind | null {
  const kind = TARGET_DETERMINERS[target].get(w1) ?? TARGET_ELIDED[target].find(([e]) => w1.startsWith(e) && w1.length > e.length)?.[1] ?? null;
  if ((kind === 'definite' || kind === 'indefinite') && w2 && POSSESSIVE_AFTER_ARTICLE[target].has(w2)) return 'possessive';
  return kind;
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
  /** false: extending would lose meaning (del/al before a bare article, a determiner of another kind) — drop instead. */
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
  if (!p || p.start < sentence.start || !/^[^\S\r\n]+$/u.test(text.slice(p.end, range.start))) return null;
  const w = straight(p.text);
  const dets = SOURCE_DETERMINERS[sourceLang];
  if (!dets.has(w)) return null;
  if (first && first.start < range.end && dets.has(straight(first.text))) return null;
  if (PRONOUN_LOOKALIKES[sourceLang].has(w) && a.pos !== 'n' && a.pos !== 'a') return null;
  const initial = !WORDCHAR.test(text.slice(sentence.start, p.start));
  const capital = /^\p{Lu}/u.test(p.text);
  if (capital && !initial) return null;
  // "El Salvador", "The Hague", "La Paz" at sentence start: a capitalised p
  // followed by a capitalised word is likely a name, so it is left alone.
  if (capital && first && first.start < range.end && /^\p{Lu}/u.test(first.text)) return null;

  const [w1, w2] = leadingWords(a.translation);
  if (!w1) return null;
  const q = tokens[k - 2];
  const stranded = !!q && q.start >= sentence.start && /^\s+$/u.test(text.slice(q.end, p.start))
    && PREDETERMINERS[sourceLang].has(straight(q.text));
  const found = (extend: boolean): LeftDeterminer => ({ token: p, extend: extend && !stranded, initial: capital });
  if (w === 'del' || w === 'al') {
    if (targetLang === 'it') {
      if (IT_ARTICULATED[w].some(e => e.endsWith("'") ? w1.startsWith(e) && w1.length > e.length : w1 === e)) return found(true);
    } else if (targetLang === 'en') {
      if (EN_PREPOSITIONS[w].has(w1) && w2 === 'the') return found(true);
    }
    return targetKind(w1, w2, targetLang) ? found(false) : null;
  }
  const kind = targetKind(w1, w2, targetLang);
  if (!kind) return null;
  const clitic = [...TARGET_CLITIC_LOOKALIKES[targetLang]].some(c => c.endsWith("'") ? w1.startsWith(c) : w1 === c);
  if (clitic && a.pos !== 'n' && a.pos !== 'a') return null;
  if (kind === dets.get(w)) return found(true);
  // A different kind: drop, unless the target word is also something else.
  return AMBIGUOUS_TARGET[targetLang].has(w1) ? null : found(false);
}

/** Uppercases the translation's first letter (l'acqua → L'acqua). */
export function capitalizeFirst(t: string): string {
  const k = t.search(/\p{L}/u);
  return k < 0 ? t : t.slice(0, k) + t[k].toLocaleUpperCase() + t.slice(k + 1);
}
