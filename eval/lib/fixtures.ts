// Eval fixtures: original texts with protected tokens marked ⟦…⟧.
//
// The loader strips the markers and returns the plain text plus the exact
// [start, end) offsets of every protected token in that plain text. Protected
// tokens (names, numbers, dates/times, URLs/emails, @handles/#tags) must never
// be covered by a swapped span.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const OPEN = '⟦'; // ⟦
export const CLOSE = '⟧'; // ⟧

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export type FixtureLang = 'en' | 'es';
export type FixtureGenre = 'news' | 'email' | 'social' | 'recipe';

export interface FixtureMeta {
  id: string;
  file: string;
  lang: FixtureLang;
  genre: FixtureGenre;
  /** Target word count; the lint test allows ±15%. */
  words: number;
  nativeChecked: boolean;
  /** The ~1,000-word text used by the latency suite. */
  latency?: boolean;
  /** Deliberately hard cases; not natural prose. */
  torture?: boolean;
  notes?: string;
  /** Override when the derived first sentence is wrong. */
  firstSentence?: string;
}

export interface ProtectedRange {
  start: number;
  end: number;
  text: string;
}

export interface Fixture extends FixtureMeta {
  raw: string;
  text: string;
  protected: ProtectedRange[];
  wordCount: number;
  firstSentence: string;
  first5Words: string;
}

export function stripMarkers(raw: string): { text: string; protected: ProtectedRange[] } {
  let text = '';
  const ranges: ProtectedRange[] = [];
  let openAt = -1;
  for (const ch of raw) {
    if (ch === OPEN) {
      if (openAt !== -1) throw new Error(`Nested ${OPEN} at plain offset ${text.length}`);
      openAt = text.length;
    } else if (ch === CLOSE) {
      if (openAt === -1) throw new Error(`Unmatched ${CLOSE} at plain offset ${text.length}`);
      if (openAt === text.length) throw new Error(`Empty protected token at plain offset ${openAt}`);
      ranges.push({ start: openAt, end: text.length, text: text.slice(openAt) });
      openAt = -1;
    } else {
      text += ch;
    }
  }
  if (openAt !== -1) throw new Error(`Unclosed ${OPEN} at plain offset ${openAt}`);
  return { text, protected: ranges };
}

const segmenters = new Map<string, Intl.Segmenter>();
function wordSegmenter(lang: string): Intl.Segmenter {
  let seg = segmenters.get(lang);
  if (!seg) {
    seg = new Intl.Segmenter(lang, { granularity: 'word' });
    segmenters.set(lang, seg);
  }
  return seg;
}

export function countWords(text: string, lang: string): number {
  let n = 0;
  for (const s of wordSegmenter(lang).segment(text)) if (s.isWordLike) n++;
  return n;
}

/** The text from the first word through the end of the n-th word. */
export function firstWords(text: string, n: number, lang: string): string {
  let start = -1;
  let count = 0;
  for (const s of wordSegmenter(lang).segment(text)) {
    if (!s.isWordLike) continue;
    if (start === -1) start = s.index;
    if (++count === n) return text.slice(start, s.index + s.segment.length);
  }
  return start === -1 ? '' : text.slice(start).trim();
}

// Lower-cased, without the final period. Single letters are always treated as
// initials ("J. Smith", "a. m."), and tokens with an inner period ("U.S.",
// "a.m.", "i.e.") as abbreviations.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'sra', 'srta', 'dra', 'prof', 'vs',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'ee', 'uu', 'ej', 'ayto', 'avda', 'pág', 'núm', 'tel', 'sáb', 'dom', 'lun', 'mié', 'vie',
]);

function isAbbreviation(token: string): boolean {
  const bare = token.replace(/^[("“‘«¿¡]+/, '').replace(/\.$/, '');
  if (bare.length === 0) return false;
  if ([...bare].length === 1 && /\p{L}/u.test(bare)) return true;
  if (bare.includes('.')) return true;
  return ABBREVIATIONS.has(bare.toLowerCase());
}

const SENTENCE_END = /[.!?…]/;
const CLOSERS = /[)"'”’»]/;
const STARTERS = /[\p{Lu}\p{N}¿¡"“‘«(]/u;

/**
 * First sentence (or first line, for headlines and subject lines). A small
 * rule set, good enough for detection variants; manifest overrides cover misfires.
 */
export function firstSentence(text: string): string {
  const start = text.search(/\S/);
  if (start === -1) return '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return text.slice(start, i).trim();
    if (!SENTENCE_END.test(ch)) continue;
    let j = i + 1;
    while (j < text.length && (SENTENCE_END.test(text[j]) || CLOSERS.test(text[j]))) j++;
    if (j >= text.length) return text.slice(start).trim();
    if (!/\s/.test(text[j])) continue;
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k < text.length && text[k] !== '\n' && !STARTERS.test(text[k])) continue;
    if (ch === '.' && j === i + 1) {
      const tokenStart = text.lastIndexOf(' ', i) + 1;
      const token = text.slice(Math.max(tokenStart, start), i + 1);
      if (isAbbreviation(token)) continue;
    }
    return text.slice(start, j).trim();
  }
  return text.slice(start).trim();
}

export function loadManifest(dir: string = FIXTURES_DIR): FixtureMeta[] {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as FixtureMeta[];
}

export function loadFixture(meta: FixtureMeta, dir: string = FIXTURES_DIR): Fixture {
  const raw = readFileSync(path.join(dir, meta.file), 'utf8');
  const { text, protected: ranges } = stripMarkers(raw);
  return {
    ...meta,
    raw,
    text,
    protected: ranges,
    wordCount: countWords(text, meta.lang),
    firstSentence: meta.firstSentence ?? firstSentence(text),
    first5Words: firstWords(text, 5, meta.lang),
  };
}

export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  return loadManifest(dir).map((m) => loadFixture(m, dir));
}
