import nlp from 'compromise';
import type { Level, Span } from './types';

// compromise only treats `|` as "or" inside parentheses: `#Noun|#Verb`
// matches nothing, `(#Noun|#Verb)` matches nouns and verbs.
const INCLUDE: Record<Level, string> = {
  1: '(#Noun|#Verb)',
  2: '(#Noun|#Verb|#Adjective|#Adverb|#Determiner|#Pronoun)',
  3: '.', // everything — exclusions applied via .not() below
};

// Never swap names, numbers, or things that aren't vocabulary.
const EXCLUDE =
  '(#ProperNoun|#Value|#Ordinal|#Cardinal|#Acronym|#PhoneNumber|#Time|#Money|#Email|#Url|#HashTag|#AtMention|#Emoji|#Emoticon)';

// A term must contain at least one letter to be worth translating. This drops
// stray emoji fragments (e.g. the middle of a ZWJ family emoji) that
// compromise sometimes tags as nouns.
const HAS_LETTER = /\p{L}/u;

type TermWithOffset = {
  offset?: { start: number; length: number };
};

type JsonView = { json: (options: object) => unknown };

function spansFromSelection(selection: JsonView, text: string): Span[] {
  const data = selection.json({ offset: true }) as Array<{ terms?: TermWithOffset[] }>;
  const spans: Span[] = [];
  for (const sentence of data) {
    for (const term of sentence.terms ?? []) {
      // Contractions expand into zero-length terms; skip them so "I'm" stays whole.
      if (!term.offset || term.offset.length === 0) continue;
      const { start, length } = term.offset;
      const termText = text.slice(start, start + length);
      if (!HAS_LETTER.test(termText)) continue;
      spans.push({ start, end: start + length, text: termText });
    }
  }
  return spans;
}

export function selectSpans(text: string, level: Level): Span[] {
  const include = INCLUDE[level];
  if (!include) throw new Error(`Invalid level: ${String(level)}`);

  const selection = nlp(text).match(include).not(EXCLUDE);
  const termSpans = spansFromSelection(selection, text);
  return mergeAdjacent(termSpans, text);
}

// Two selected terms join into one phrase when only spaces/tabs or a single
// hyphen separate them ("the red car", "well-known"). Line breaks always end a
// phrase so paragraphs survive and the numbered prompt list stays one-per-line.
const JOINABLE_GAP = /^(?:[^\S\r\n]+|-)$/;

export function mergeAdjacent(spans: Span[], text: string): Span[] {
  if (spans.length === 0) return [];
  const merged: Span[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = spans[i];
    const gap = text.slice(prev.end, curr.start);
    if (gap === '' || JOINABLE_GAP.test(gap)) {
      merged[merged.length - 1] = { start: prev.start, end: curr.end, text: text.slice(prev.start, curr.end) };
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}
