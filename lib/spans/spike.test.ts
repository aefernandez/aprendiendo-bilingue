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
import { checkRunShape, formatRunStats, runStats } from './runs';

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
      // No fallbacks: every item is found forward in order (same sentence, or the next one).
      expect(r.stats.aligned.case + r.stats.aligned.backtrack).toBe(0);
      expect(r.stats.aligned.exact + r.stats.aligned.next).toBe(r.stats.received);
      for (const k of r.kept) expect(p.text.slice(k.start, k.end)).toBe(k.source);
      expect(coverage(tokens, r.kept)).toBeGreaterThan(0.5);
    });
  }

  it('totals 405 items, all kept', () => {
    expect([received, kept]).toEqual([405, 405]);
  });

  // Run-shape report (PR-1). All 12 replies FAIL the level-2 shape (median > 6
  // or > 30% of runs over 8 words): a finding about the model, reported here
  // and NOT asserted as a gate. Only the invariants and the pinned numbers are
  // asserted, so the pins change if the parser/validator/metric change.
  describe('run shape', () => {
    // Hand-checked on es-it.default.r1 (first runs: 7, 2, 4, 16 words).
    const PINNED: Record<string, { runs: number; median: number; max: number }> = {
      'en-it.default.r1.txt': { runs: 20, median: 5, max: 16 },
      'en-it.default.r2.txt': { runs: 13, median: 13, max: 22 },
      'en-it.makora.r1.txt': { runs: 22, median: 5, max: 14 },
      'en-it.makora.r2.txt': { runs: 22, median: 5, max: 13 },
      'es-en.default.r1.txt': { runs: 16, median: 8, max: 20 },
      'es-en.default.r2.txt': { runs: 18, median: 6, max: 14 },
      'es-en.makora.r1.txt': { runs: 17, median: 7, max: 20 },
      'es-en.makora.r2.txt': { runs: 17, median: 9, max: 16 },
      'es-it.default.r1.txt': { runs: 15, median: 6, max: 22 },
      'es-it.default.r2.txt': { runs: 16, median: 5.5, max: 22 },
      'es-it.makora.r1.txt': { runs: 16, median: 4.5, max: 23 },
      'es-it.makora.r2.txt': { runs: 16, median: 4.5, max: 23 },
    };
    for (const f of files) {
      it(`reports run stats for ${f}`, () => {
        const p = PASSAGES.find(x => x.id === f.split('.')[0])!;
        const parsed = parseItems(readFileSync(DIR + f, 'utf8'))!;
        const { tokens, masked } = tokenizeWords(p.text, p.source);
        const r = validateItems(parsed.items, { text: p.text, tokens, masked, sentences: sentenceRanges(p.text, p.source) });
        const s = runStats(p.text, r.kept, p.target);
        const shape = checkRunShape(s, 2);
        console.info(`${f.padEnd(24)} ${formatRunStats(s, 2)}${shape.ok ? '' : ` [${shape.violations.join('; ')}]`}`);
        expect(s.runs).toBeGreaterThanOrEqual(1);
        expect(s.lengths.reduce((a, b) => a + b, 0)).toBe(s.words);
        const perItem = r.kept
          .filter(k => !k.cognate)
          .reduce((n, k) => n + tokenizeWords(k.translation, p.target).tokens.length, 0);
        expect(s.words).toBe(perItem);
        expect({ runs: s.runs, median: s.median, max: s.max }).toEqual(PINNED[f]);
      });
    }
  });
});
