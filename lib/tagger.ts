import nlp from 'compromise';
import type { Level, Span } from './types';

// Tags that are never translated regardless of level
const EXCLUDED = new Set([
  'ProperNoun', 'Acronym', 'Value', 'Ordinal', 'Cardinal',
]);

// Tags selected per level; Level 3 = include everything minus EXCLUDED
const LEVEL_TAGS: Record<1 | 2, Set<string>> = {
  1: new Set(['Noun', 'Verb']),
  2: new Set(['Noun', 'Verb', 'Adjective', 'Adverb', 'Determiner', 'Pronoun']),
};

function isSelected(tags: string[], level: Level): boolean {
  if (tags.some(t => EXCLUDED.has(t))) return false;
  if (level === 3) return true;
  return tags.some(t => LEVEL_TAGS[level].has(t));
}

type CompromiseTerm = {
  text: string;
  tags: Record<string, boolean>;
  offset?: { start: number; length: number };
};

export function selectSpans(text: string, level: Level): Span[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sentences = (nlp(text).json({ offset: true }) as any[]) as Array<{
    terms: CompromiseTerm[];
  }>;

  const termSpans: Span[] = [];
  for (const sentence of sentences) {
    for (const term of sentence.terms) {
      if (!term.offset) continue;
      const { start, length } = term.offset;
      const end = start + length;
      const tags = Object.keys(term.tags);
      if (isSelected(tags, level)) {
        termSpans.push({ start, end, text: text.slice(start, end) });
      }
    }
  }

  return mergeAdjacent(termSpans, text);
}

function mergeAdjacent(spans: Span[], text: string): Span[] {
  if (spans.length === 0) return [];
  const merged: Span[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = spans[i];
    const gap = text.slice(prev.end, curr.start);
    if (/^\s*$/.test(gap)) {
      merged[merged.length - 1] = {
        start: prev.start,
        end: curr.end,
        text: text.slice(prev.start, curr.end),
      };
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}
