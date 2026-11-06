// Protected tokens: names and numbers inside a source span must survive in its
// translation, or the swap silently deletes them ("Carmen prepara" → "prepares").
//
// NAME RULE. A token is a name when it starts with a capital letter, is not an
// ordinary capitalised word (ORDINARY_CAPS: I/I'm…, days, months, languages and
// nationalities, holidays, family titles, Usted), and at least one holds:
//   1. it is not in initial position (sentence start, or right after an opening
//      quote/¿/¡/bracket/dash);
//   2. the same form also appears capitalised in a non-initial position
//      elsewhere in the text ("María come. … dijo María").
// (Adjacency — "Carmen Ruiz" — is not used for initial words: "Ayer Carmen"
// looks the same.)
// A sentence-initial name that occurs only once ("«Pedro come pan», dijo.") is
// not detectable without a lexicon; the weaker INITIAL RULE then applies: a span
// that starts at an initial capitalised word must get a translation containing
// a capitalised word.
//
// A missing name is accepted when the translation has a capitalised word (not
// its first word, not one of the matched names) for it — exonyms: España →
// Spagna. Names are matched on word boundaries (Ana ≠ Anaconda).
//
// NUMBER RULE. Each number must appear in the translation with the same digit
// sequence. A decimal/time separator must be kept (3,5 → 3.5 ok, 3,5 → 35 not);
// a thousands separator (exactly 3 digits after it) may be dropped or changed.

import type { TextRange, WordToken } from './tokenize';

const ORDINARY_CAPS = new Set([
  "i", "i'm", "i've", "i'll", "i'd",
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  'english', 'spanish', 'italian', 'french', 'german', 'portuguese', 'catalan', 'chinese', 'japanese',
  'american', 'british', 'european', 'mexican', 'argentinian', 'argentine', 'latin', 'african', 'asian',
  'christmas', 'easter', 'halloween', 'thanksgiving', 'new',
  'mom', 'mum', 'dad', 'mommy', 'daddy', 'grandma', 'grandpa', 'granny', 'mr', 'mrs', 'ms', 'dr',
  'usted', 'ustedes', 'ud', 'uds', 'vd', 'vds',
]);
const OPENER_BEFORE = /[«"“‘'¿¡(\[—–-]\s*$/u;
const CAP = /^\p{Lu}/u;
const NUMBER_IN_TEXT = /\p{Nd}+(?:[.,:'’]\p{Nd}+)*/gu;

const straight = (s: string) => s.normalize('NFC').replace(/[’ʼ‘]/g, "'");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export interface Protection {
  /** True when the translation loses a protected name or number of these tokens. */
  lost(inside: readonly WordToken[], translation: string): boolean;
}

export function buildProtection(text: string, tokens: readonly WordToken[], sentences: readonly TextRange[]): Protection {
  const starts = new Set<number>();
  {
    const ss = sentences.map(s => s.start).sort((a, b) => a - b);
    let k = 0;
    for (const s of ss) {
      while (k < tokens.length && tokens[k].start < s) k++;
      if (k < tokens.length) starts.add(tokens[k].start);
    }
    if (tokens.length) starts.add(tokens[0].start);
  }
  const ordinary = (t: WordToken) => ORDINARY_CAPS.has(straight(t.text).toLowerCase());
  const capital = (t: WordToken | undefined) => !!t && CAP.test(t.text) && !t.numeric && !ordinary(t);
  const initial = (t: WordToken) =>
    starts.has(t.start) || OPENER_BEFORE.test(text.slice(Math.max(0, t.start - 3), t.start));

  const midForms = new Set<string>();
  for (const t of tokens) if (capital(t) && !initial(t)) midForms.add(straight(t.text));
  const names = new Set<number>();
  for (const t of tokens) {
    if (capital(t) && (!initial(t) || midForms.has(straight(t.text)))) names.add(t.start);
  }

  return {
    lost(inside, translation) {
      const tr = straight(translation);
      // numbers
      const trNumbers = [...tr.matchAll(NUMBER_IN_TEXT)].map(m => m[0]);
      for (const tok of inside) {
        if (!tok.numeric) continue;
        const num = /\p{Nd}+(?:[.,:'’]\p{Nd}+)*/u.exec(tok.text)?.[0];
        if (!num) continue;
        const digits = num.replace(/\D/g, '');
        const sepMustStay = /[.,:'’]\p{Nd}{1,2}$|[.,:'’]\p{Nd}{4,}|:/u.test(num) && /[.,:'’]/.test(num);
        const ok = trNumbers.some(n => n.replace(/\D/g, '') === digits && (!sepMustStay || /[.,:'’]/.test(n)));
        if (!ok) return true;
      }
      // names
      const missing: string[] = [];
      const matched: string[] = [];
      for (const tok of inside) {
        if (!names.has(tok.start)) continue;
        const name = straight(tok.text);
        if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'u').test(tr)) matched.push(name);
        else missing.push(name);
      }
      if (missing.length) {
        const caps = [...tr.matchAll(/[\p{L}\p{M}'’-]+/gu)].slice(1).map(m => m[0]).filter(w => CAP.test(w) && !matched.includes(w));
        if (caps.length < missing.length) return true;
      }
      // initial rule
      const first = inside[0];
      if (first && capital(first) && initial(first) && !names.has(first.start) && !/\p{Lu}/u.test(tr)) return true;
      return false;
    },
  };
}
