import { describe, expect, it } from 'vitest';
import { mergeAdjacent, selectSpans } from './tagger';
import type { Level } from './types';

const PARAGRAPH =
  'My grandmother moved to Chicago in 1962 with her two brothers. ' +
  'They opened a small bakery on Taylor Street, and within five years it became ' +
  'one of the most popular shops in the neighborhood.';

function texts(text: string, level: Level) {
  return selectSpans(text, level).map(s => s.text);
}

function swappedWordShare(text: string, level: Level) {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const swapped = selectSpans(text, level).reduce((n, s) => n + words(s.text), 0);
  return swapped / words(text);
}

describe('selectSpans', () => {
  it.each([1, 2, 3] as Level[])('selects something at level %i', level => {
    expect(selectSpans(PARAGRAPH, level).length).toBeGreaterThan(0);
  });

  it('swaps more at each higher level', () => {
    const l1 = swappedWordShare(PARAGRAPH, 1);
    const l2 = swappedWordShare(PARAGRAPH, 2);
    const l3 = swappedWordShare(PARAGRAPH, 3);
    expect(l1).toBeGreaterThan(0);
    expect(l2).toBeGreaterThan(l1);
    expect(l3).toBeGreaterThan(l2);
    expect(l3).toBeLessThan(1);
  });

  it('never swaps proper nouns, numbers, or contact details', () => {
    const text = 'John from NASA met Mary in Turkey in May, paid $5 on the 3rd, then called 555-1234 at 5pm.';
    for (const level of [1, 2, 3] as Level[]) {
      const joined = texts(text, level).join(' | ');
      for (const kept of ['John', 'NASA', 'Mary', 'Turkey', 'May', '$5', '3rd', '555-1234', '5pm']) {
        expect(joined, `level ${level} swapped ${kept}`).not.toContain(kept);
      }
    }
  });

  it('spans match the text at their offsets', () => {
    const text = 'Café “owners” don’t sleep.\r\nI’m tired — the 🍕 was great!';
    for (const level of [1, 2, 3] as Level[]) {
      for (const span of selectSpans(text, level)) {
        expect(text.slice(span.start, span.end)).toBe(span.text);
      }
    }
  });

  it('never merges across line breaks', () => {
    const text = 'Shopping list\nbuy milk\nwash the car\n\nCall mom tonight';
    for (const span of selectSpans(text, 3)) {
      expect(span.text).not.toMatch(/[\r\n]/);
    }
  });

  it('keeps hyphenated words whole', () => {
    expect(texts('A well-known tool for everyone.', 3).join(' | ')).toContain('well-known');
  });

  it('skips emoji fragments', () => {
    for (const span of selectSpans('I love 👨‍👩‍👧 family dinners.', 3)) {
      expect(span.text).toMatch(/\p{L}/u);
    }
  });

  it('rejects an invalid level instead of crashing later', () => {
    expect(() => selectSpans(PARAGRAPH, 4 as Level)).toThrow(/Invalid level/);
  });
});

describe('mergeAdjacent', () => {
  const text = 'the red car.  next\tword\nnew-line';
  const span = (start: number, end: number) => ({ start, end, text: text.slice(start, end) });

  it('merges across spaces and tabs', () => {
    expect(mergeAdjacent([span(0, 3), span(4, 7), span(8, 11)], text)).toEqual([span(0, 11)]);
    expect(mergeAdjacent([span(14, 18), span(19, 23)], text)).toEqual([span(14, 23)]);
  });

  it('does not merge across punctuation or newlines', () => {
    expect(mergeAdjacent([span(8, 11), span(14, 18)], text)).toHaveLength(2);
    expect(mergeAdjacent([span(19, 23), span(24, 27)], text)).toHaveLength(2);
  });
});
