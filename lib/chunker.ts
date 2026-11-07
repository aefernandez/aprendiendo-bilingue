// Splits a text into chunks along sentence and paragraph boundaries so each
// chunk can be translated in its own model call. Pure: no LLM, no I/O.
//
// Offsets are always into the original text: chunks tile [0, text.length)
// with no gaps or overlaps, so the source text is never rewritten.

import { getSegmenter } from './intlSegmenters';

export interface TextRange {
  start: number;
  end: number;
}

export interface Chunk extends TextRange {
  index: number;
  // The sentences (or, for an over-long sentence, its word-boundary pieces)
  // that make up this chunk, in order. They tile [start, end).
  sentences: TextRange[];
}

export interface ChunkOptions {
  locale: string;
  // Target weight per chunk. Raised to ceil(total / maxChunks) when needed.
  target: number;
  maxChunks: number;
  // Weight of a range; must be additive (weight(a ∪ b) = weight(a) + weight(b)
  // for adjacent ranges). Default: character count.
  weight?: (range: TextRange) => number;
  // Never cut inside these ranges (T: the selected phrases; B3: masked URLs).
  protect?: TextRange[];
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

// A period after one of these is not a sentence end. Matched against the end
// of a sentence candidate, preceded by start of text or a non-letter, whatever
// follows. English and Spanish, since B3 reuses this for both.
// Leave out common words that end sentences ("no.", "fig.", "cap.", "aprox."):
// Intl already keeps "fig. 3" or "aprox. 5" together, so they only add merges.
const ABBREVIATIONS = [
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Dra.', 'Prof.', 'Sr.', 'Sra.', 'Srta.', 'Jr.', 'St.', 'Sto.', 'Sta.',
  'Ud.', 'Uds.', 'vs.', 'etc.', 'approx.', 'e.g.', 'i.e.', 'a.m.', 'p.m.', 'a. m.', 'p. m.', 'p. ej.',
  'EE.', 'UU.', 'EE. UU.', 'No.', 'Nos.',
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.', 'Oct.', 'Nov.', 'Dec.',
  'ene.', 'abr.', 'ago.', 'dic.',
  'Capt.', 'Col.', 'Gen.', 'Lt.', 'Sgt.', 'Rev.', 'Gov.', 'Sen.', 'Rep.', 'Hon.', 'Mt.', 'Ft.', 'Ave.', 'Messrs.',
  'vol.', 'ch.', 'p.', 'pp.',
  'Lic.', 'Ing.', 'Arq.', 'Avda.', 'Av.', 'Dña.', 'Sres.', 'Sras.', 'Excmo.', 'Excma.',
  'núm.', 'Núm.', 'pág.', 'págs.', 'tel.', 'Cía.',
];

const BEFORE_ABBREVIATION = /[^\p{L}\p{N}]$/u;
// A single capital letter and a period: an initial ("J. R. R. Tolkien", "U.S.").
const INITIAL = /(?:^|[^\p{L}])\p{Lu}\.$/u;
const STARTS_LOWERCASE = /^[\s"'“‘«(\[]*\p{Ll}/u;
const PARAGRAPH_END = /\n[^\S\n]*$/;

function endsWithAbbreviation(candidate: string): boolean {
  const trimmed = candidate.trimEnd();
  if (INITIAL.test(trimmed)) return true;
  return ABBREVIATIONS.some((abbr) => {
    if (!trimmed.endsWith(abbr)) return false;
    const before = trimmed.slice(0, trimmed.length - abbr.length);
    return before === '' || BEFORE_ABBREVIATION.test(before);
  });
}

/**
 * Sentence ranges tiling the whole text. Uses Intl.Segmenter, then undoes the
 * breaks it makes after abbreviations and initials ("Mr. Smith", "EE. UU.")
 * and before a lowercase word. A break after a line break (paragraph or line
 * end) is always kept.
 */
export function splitSentences(text: string, locale: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const { index, segment } of getSegmenter(locale, 'sentence').segment(text)) {
    const range = { start: index, end: index + segment.length };
    const prev = ranges[ranges.length - 1];
    if (prev && shouldMerge(text.slice(prev.start, prev.end), segment)) prev.end = range.end;
    else ranges.push(range);
  }
  return ranges;
}

function shouldMerge(previous: string, next: string): boolean {
  if (PARAGRAPH_END.test(previous)) return false;
  return endsWithAbbreviation(previous) || STARTS_LOWERCASE.test(next);
}

export function isParagraphEnd(text: string, range: TextRange): boolean {
  return PARAGRAPH_END.test(text.slice(range.start, range.end));
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

// Close a chunk at a paragraph end once it holds this share of the target.
const PARAGRAPH_FILL = 0.6;

interface Unit extends TextRange {
  weight: number;
  paragraphEnd: boolean;
}

function insideProtected(position: number, protect: TextRange[]): boolean {
  // protect is small (hundreds) and this runs once per boundary candidate;
  // binary search keeps it O(log n).
  let lo = 0;
  let hi = protect.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = protect[mid];
    if (position <= r.start) hi = mid - 1;
    else if (position >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}

// Cut an over-weight sentence at word boundaries into pieces of at most
// `target` weight (a single word heavier than the target becomes its own piece).
function hardSplit(
  text: string,
  sentence: TextRange,
  target: number,
  weight: (r: TextRange) => number,
  locale: string,
  protect: TextRange[],
): TextRange[] {
  const boundaries: number[] = [];
  const body = text.slice(sentence.start, sentence.end);
  for (const { index, isWordLike } of getSegmenter(locale, 'word').segment(body)) {
    const position = sentence.start + index;
    if (isWordLike && index > 0 && !insideProtected(position, protect)) boundaries.push(position);
  }

  const pieces: TextRange[] = [];
  let start = sentence.start;
  let lastFit = -1;
  for (const b of boundaries) {
    while (b > start && weight({ start, end: b }) > target) {
      const cut = lastFit > start ? lastFit : b;
      pieces.push({ start, end: cut });
      start = cut;
      lastFit = -1;
    }
    if (b > start) lastFit = b;
  }
  pieces.push({ start, end: sentence.end });
  return pieces;
}

interface Group {
  units: Unit[];
  weight: number;
}

function pack(units: Unit[], target: number, paragraphs = true): Group[] {
  const groups: Group[] = [];
  let current: Group = { units: [], weight: 0 };
  for (const unit of units) {
    if (current.units.length > 0 && current.weight + unit.weight > target) {
      groups.push(current);
      current = { units: [], weight: 0 };
    }
    current.units.push(unit);
    current.weight += unit.weight;
    if (paragraphs && unit.paragraphEnd && current.weight >= target * PARAGRAPH_FILL) {
      groups.push(current);
      current = { units: [], weight: 0 };
    }
  }
  if (current.units.length > 0) groups.push(current);
  return groups;
}

/**
 * Packs sentences greedily into chunks of about `target` weight, closing early
 * at a paragraph end once a chunk is 60% full, and never producing more than
 * `maxChunks` chunks. Chunks tile [0, text.length) exactly.
 */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  if (text.length === 0) return [];
  const weight = opts.weight ?? ((r: TextRange) => r.end - r.start);
  const protect = [...(opts.protect ?? [])].sort((a, b) => a.start - b.start);
  const maxChunks = Math.max(1, opts.maxChunks);

  const sentences = splitSentences(text, opts.locale);
  const total = sentences.reduce((n, s) => n + weight(s), 0);
  const target = Math.max(opts.target, Math.ceil(total / maxChunks));

  // Units: sentences, with over-weight ones cut into pieces. Boundaries that
  // fall inside a protected range are removed by merging the two sides.
  const units: Unit[] = [];
  for (const sentence of sentences) {
    const pieces = weight(sentence) > target
      ? hardSplit(text, sentence, target, weight, opts.locale, protect)
      : [sentence];
    for (const piece of pieces) {
      const prev = units[units.length - 1];
      if (prev && insideProtected(piece.start, protect)) {
        prev.end = piece.end;
        prev.weight += weight(piece);
        prev.paragraphEnd = isParagraphEnd(text, piece);
      } else {
        units.push({ ...piece, weight: weight(piece), paragraphEnd: isParagraphEnd(text, piece) });
      }
    }
  }

  // Greedy packing. If it makes too many chunks, raise the target to the
  // smallest value that fits in maxChunks; at that point even chunk sizes
  // matter more than ending chunks at paragraphs, so pack without them.
  let groups = pack(units, target);
  if (groups.length > maxChunks) {
    let lo = target;
    let hi = Math.max(target, total);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (pack(units, mid, false).length <= maxChunks) hi = mid;
      else lo = mid + 1;
    }
    groups = pack(units, lo, false);
  }

  // Still too many (only when single units outweigh the target): merge the
  // lightest adjacent pair until under the cap.
  while (groups.length > maxChunks) {
    let best = 0;
    for (let i = 1; i < groups.length - 1; i++) {
      if (groups[i].weight + groups[i + 1].weight < groups[best].weight + groups[best + 1].weight) best = i;
    }
    const [a, b] = [groups[best], groups[best + 1]];
    groups.splice(best, 2, { units: [...a.units, ...b.units], weight: a.weight + b.weight });
  }

  return groups.map((group, index) => ({
    index,
    start: group.units[0].start,
    end: group.units[group.units.length - 1].end,
    sentences: group.units.map(({ start, end }) => ({ start, end })),
  }));
}
