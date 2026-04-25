import nlp from 'compromise';
import type { Level, Span } from './types';

// Use compromise's native #Tag selector syntax, which correctly resolves
// tag hierarchies (e.g. #Noun matches Singular, Plural, etc.)
const INCLUDE: Record<Level, string> = {
  1: '#Noun|#Verb',
  2: '#Noun|#Verb|#Adjective|#Adverb|#Determiner|#Pronoun',
  3: '.',  // everything — exclusions applied via .not() below
};

const EXCLUDE = '#ProperNoun|#Value|#Ordinal|#Cardinal|#Acronym';

type TermWithOffset = {
  offset?: { start: number; length: number };
};

function spansFromSelection(selection: ReturnType<typeof nlp>, text: string): Span[] {
  const data = selection.json({ offset: true }) as Array<{ terms: TermWithOffset[] }>;
  const spans: Span[] = [];
  for (const sentence of data) {
    for (const term of sentence.terms ?? []) {
      if (!term.offset || term.offset.length === 0) continue;
      const { start, length } = term.offset;
      spans.push({ start, end: start + length, text: text.slice(start, start + length) });
    }
  }
  return spans;
}

export function selectSpans(text: string, level: Level): Span[] {
  const doc = nlp(text);
  const selection = level === 3
    ? doc.match(INCLUDE[3]).not(EXCLUDE)
    : doc.match(INCLUDE[level]).not(EXCLUDE);

  const termSpans = spansFromSelection(selection, text);
  return mergeAdjacent(termSpans, text);
}

function mergeAdjacent(spans: Span[], text: string): Span[] {
  if (spans.length === 0) return [];
  const merged: Span[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = spans[i];
    if (/^\s*$/.test(text.slice(prev.end, curr.start))) {
      merged[merged.length - 1] = { start: prev.start, end: curr.end, text: text.slice(prev.start, curr.end) };
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}
