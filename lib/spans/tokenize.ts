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

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'“”‘’«»]+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/u;
const TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'io', 'es', 'it', 'co', 'uk', 'mx', 'ar', 'cl', 'pe',
  'dev', 'app', 'info', 'eu', 'us',
]);
const DOMAIN_TOKEN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

const APOS = new Set(["'", '’', 'ʼ']);
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
    const raw = m[0].replace(TRAILING_PUNCT, '');
    out.push({ start, end: start + raw.length, kind: 'url' });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].replace(TRAILING_PUNCT, '').length;
    if (!out.some(o => start < o.end && end > o.start)) out.push({ start, end, kind: 'email' });
  }
  return out.sort((a, b) => a.start - b.start);
}

interface RawSegment {
  start: number;
  end: number;
  text: string;
  word: boolean;
}

/**
 * Splits `text` into indexable word tokens with `Intl.Segmenter`, then merges:
 * - letter + apostrophe/hyphen + letter with no spaces (well-known, mother-in-law, post-COVID);
 * - plural possessives (dogs') — unless the word opened with a quote ('yes');
 * - digit:digit times (10:30).
 * URLs and emails are blanked before segmenting; dotted tokens ending in a known
 * TLD (x.com) are masked after. Punctuation, ¿¡, quotes and emoji get no index.
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
      !APOS.has(text[prev.start - 1] ?? '')
    ) {
      merged[merged.length - 1] = { ...prev, end: cur.end, text: text.slice(prev.start, cur.end) };
      continue;
    }
    merged.push(cur);
  }

  const tokens: WordToken[] = [];
  for (const r of merged) {
    if (!r.word) continue;
    if (
      DOMAIN_TOKEN.test(r.text) &&
      /\.\p{L}/u.test(r.text) &&
      TLDS.has((r.text.split('.').pop() ?? '').toLowerCase())
    ) {
      masked.push({ start: r.start, end: r.end, kind: 'domain' });
      continue;
    }
    tokens.push({ i: tokens.length, start: r.start, end: r.end, text: r.text, numeric: isNumeric(r.text) });
  }
  masked.sort((a, b) => a.start - b.start);
  return { tokens, masked };
}
