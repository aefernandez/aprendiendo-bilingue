// Word tokenizer for the index-format span engine.
//
// Every word gets an index the model refers to. Offsets are UTF-16 offsets into
// the ORIGINAL text (never normalized), so source text is never rewritten.

export interface TextRange {
  start: number;
  end: number;
}

export interface WordToken {
  /** Index the model sees; chunk-local after `chunkTokens`. */
  i: number;
  /** UTF-16 offsets into the original text. */
  start: number;
  end: number;
  text: string;
  /** Numbers are never valid range endpoints. */
  numeric: boolean;
}

export type MaskKind = 'url' | 'email' | 'domain';

export interface Masked extends TextRange {
  kind: MaskKind;
}

export interface Tokenized {
  tokens: WordToken[];
  /** Ranges that get no index (URLs, emails, bare domains), sorted by start. */
  masked: Masked[];
}

const TLDS = [
  'com', 'org', 'net', 'edu', 'gov', 'io', 'es', 'it', 'co', 'uk', 'mx', 'ar', 'cl', 'pe',
  'dev', 'app', 'info', 'eu', 'us',
];
const TLD_SET = new Set(TLDS);
// Scheme or www. URLs, plus bare domains followed by a path (example.com/path?q=1).
const URL_RE = new RegExp(
  String.raw`(?:\b(?:https?|ftp):\/\/|\bwww\.|(?<![\p{L}\p{N}.@_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:${TLDS.join('|')})(?=\/))` +
    String.raw`[^\s<>"'“”‘’«»]*`,
  'giu',
);
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const DOMAIN_TOKEN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
// A dotted word whose label before the dot is one of these is an abbreviation, not a domain (etc.es).
const ABBREVIATIONS = new Set(['etc', 'ej', 'pág', 'pag', 'vol', 'núm', 'num', 'cap', 'art', 'fig', 'aprox', 'approx', 'vs', 'cf']);

/** Strip trailing sentence punctuation from a URL/email match; keep a ")" that closes a "(" inside it. */
function trimTrailing(raw: string): string {
  let out = raw;
  for (;;) {
    const last = out[out.length - 1];
    if (!last || !'.,;:!?)]}'.includes(last)) return out;
    if (last === ')' && count(out, '(') >= count(out, ')')) return out;
    if (last === ']' && count(out, '[') >= count(out, ']')) return out;
    out = out.slice(0, -1);
  }
}
function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

const APOS = new Set(["'", '’', 'ʼ']);
const QUOTE_APOS = new Set(["'", '’', 'ʼ', '‘']);
const HYPHENS = new Set(['-', '‐', '‑']);
const LETTER = /\p{L}/u;
const LETTER_END = /\p{L}\p{M}*$/u;
const LETTER_START = /^\p{L}/u;
const DIGIT = /\p{Nd}/u;
const ORDINAL_MARKS = /[ºª°]/gu;

/**
 * Numeric = starts with a digit, or contains a digit and no letter (ignoring º ª °).
 * So 2º, 3años, 30h, 10:30h, 4.5km and 1st are numeric; B2B and mp3 are words.
 */
export function isNumeric(token: string): boolean {
  if (!DIGIT.test(token)) return false;
  if (/^\p{Nd}/u.test(token)) return true;
  return !LETTER.test(token.replace(ORDINAL_MARKS, ''));
}

function findMasks(text: string): Masked[] {
  const out: Masked[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = trimTrailing(m[0]);
    if (raw) out.push({ start, end: start + raw.length, kind: 'url' });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index ?? 0;
    const end = start + trimTrailing(m[0]).length;
    if (!out.some(o => start < o.end && end > o.start)) out.push({ start, end, kind: 'email' });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * True when a single quote opened before `pos` in the same sentence is still
 * unclosed, so an apostrophe at `pos` is a closing quote, not a possessive.
 * Opening = quote with no letter before and a letter after; closing = the reverse.
 */
function openQuoteBefore(text: string, pos: number): boolean {
  let from = pos;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1])) from--;
  let open = 0;
  for (let k = from; k < pos; k++) {
    if (!QUOTE_APOS.has(text[k])) continue;
    const before = LETTER_END.test(text.slice(Math.max(0, k - 2), k));
    const after = LETTER_START.test(text.slice(k + 1, k + 3));
    if (!before && after) open++;
    else if (before && !after && open > 0) open--;
  }
  return open > 0;
}

interface RawSegment {
  start: number;
  end: number;
  text: string;
  word: boolean;
}

/**
 * Splits `text` into indexable word tokens with `Intl.Segmenter`, then merges:
 * - letter + apostrophe/hyphen + letter with no spaces (well-known, mother-in-law,
 *   post-COVID; the segmenter already keeps don't and rock’n’roll whole, but
 *   rock-'n'-roll stays three tokens);
 * - plural possessives (dogs') — unless a single quote is still open in the
 *   sentence, so ‘yes’ and 'los gatos' keep their closing quote outside;
 * - digit:digit times (10:30).
 * URLs (scheme, www., or bare domain + path) and emails are blanked before
 * segmenting; dotted tokens ending in a known TLD (x.com) are masked after,
 * except "fin.Es"/"etc.es"-style glue, which is split into words.
 * Punctuation, ¿¡, quotes and emoji get no index.
 */
export function tokenizeWords(text: string, locale: string): Tokenized {
  const masked = findMasks(text);
  // Blank masked ranges with same-length spaces so offsets are preserved.
  let blanked = text;
  for (const m of masked) {
    blanked = blanked.slice(0, m.start) + ' '.repeat(m.end - m.start) + blanked.slice(m.end);
  }

  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  const raw: RawSegment[] = [];
  for (const s of segmenter.segment(blanked)) {
    const end = s.index + s.segment.length;
    raw.push({ start: s.index, end, text: text.slice(s.index, end), word: !!s.isWordLike });
  }

  const merged: RawSegment[] = [];
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k];
    const prev = merged[merged.length - 1];
    const next = raw[k + 1];
    if (prev && prev.word && next && next.word && prev.end === cur.start && cur.end === next.start) {
      const joinLetters =
        (APOS.has(cur.text) || HYPHENS.has(cur.text)) &&
        LETTER_END.test(prev.text) &&
        LETTER_START.test(next.text);
      const joinTime = cur.text === ':' && /\p{Nd}$/u.test(prev.text) && /^\p{Nd}/u.test(next.text);
      if (joinLetters || joinTime) {
        merged[merged.length - 1] = { start: prev.start, end: next.end, text: text.slice(prev.start, next.end), word: true };
        k++;
        continue;
      }
    }
    if (
      prev && prev.word && APOS.has(cur.text) && prev.end === cur.start &&
      /[sS]$/.test(prev.text) &&
      !(next && next.start === cur.end && next.word) &&
      !openQuoteBefore(text, cur.start)
    ) {
      merged[merged.length - 1] = { ...prev, end: cur.end, text: text.slice(prev.start, cur.end) };
      continue;
    }
    merged.push(cur);
  }

  const tokens: WordToken[] = [];
  const push = (start: number, end: number) => {
    const t = text.slice(start, end);
    tokens.push({ i: tokens.length, start, end, text: t, numeric: isNumeric(t) });
  };
  for (const r of merged) {
    if (!r.word) continue;
    if (DOMAIN_TOKEN.test(r.text) && /\.\p{L}/u.test(r.text)) {
      const labels = r.text.split('.');
      // A missing space after a full stop ("fin.Es", "Italia.It") or an
      // abbreviation ("etc.es"): split into words at the dots.
      const sentenceGlue = labels.some((l, k) => k > 0 && /^\p{Lu}/u.test(l) && /\p{Ll}/u.test(labels[k - 1]));
      const abbreviation = ABBREVIATIONS.has(labels[labels.length - 2].toLowerCase());
      if (sentenceGlue || abbreviation) {
        let at = r.start;
        for (const l of labels) {
          if (l) push(at, at + l.length);
          at += l.length + 1;
        }
        continue;
      }
      if (TLD_SET.has(labels[labels.length - 1].toLowerCase())) {
        masked.push({ start: r.start, end: r.end, kind: 'domain' });
        continue;
      }
    }
    push(r.start, r.end);
  }
  masked.sort((a, b) => a.start - b.start);
  return { tokens, masked };
}
