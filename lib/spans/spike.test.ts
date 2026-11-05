// The 12 real substring-format replies from the team's live spike (Nov 5 2026,
// google/gemma-4-26b-a4b-it, level 2) as fixtures. Every item must align.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PASSAGES } from './__fixtures__/spike/passages';
import { parseItems } from './parse';
import { tokenizeWords, type TextRange } from './tokenize';
import { validateItems } from './validate';
import { coverage } from './coverage';

const DIR = fileURLToPath(new URL('./__fixtures__/spike/', import.meta.url));

function sentenceRanges(text: string, locale: string): TextRange[] {
  const out: TextRange[] = [];
  for (const s of new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)) {
    out.push({ start: s.index, end: s.index + s.segment.length });
  }
  return out;
}

const files = readdirSync(DIR).filter(f => f.endsWith('.txt')).sort();

describe('spike replies (substring format)', () => {
  it('has the 12 replies', () => {
    expect(files).toHaveLength(12);
  });

  let received = 0;
  let kept = 0;
  for (const f of files) {
    it(`aligns every item in ${f}`, () => {
      const p = PASSAGES.find(x => x.id === f.split('.')[0])!;
      const parsed = parseItems(readFileSync(DIR + f, 'utf8'));
      expect(parsed).not.toBeNull();
      const { tokens, masked } = tokenizeWords(p.text, p.source);
      const r = validateItems(parsed!.items, { text: p.text, tokens, masked, sentences: sentenceRanges(p.text, p.source) });
      received += r.stats.received;
      kept += r.stats.kept;
      expect(r.stats.dropped).toEqual({});
      expect(r.stats.aligned).toEqual({ exact: r.stats.received, case: 0, backtrack: 0, jump: 0 });
      for (const k of r.kept) expect(p.text.slice(k.start, k.end)).toBe(k.source);
      expect(coverage(tokens, r.kept)).toBeGreaterThan(0.5);
    });
  }

  it('totals 405 items, all kept', () => {
    expect([received, kept]).toEqual([405, 405]);
  });
});
