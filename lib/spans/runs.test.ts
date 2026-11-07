import { describe, expect, it } from 'vitest';
import { LENGTH_RULES, checkRunShape, formatRunStats, runStats, type RunStats } from './runs';

type K = { start: number; end: number; cognate: boolean; translation: string };

/** Kept item for the first occurrence of `src` at or after `from`. */
function k(text: string, src: string, tr: string, cognate = false, from = 0): K {
  const start = text.indexOf(src, from);
  if (start < 0) throw new Error(`no "${src}"`);
  return { start, end: start + src.length, cognate, translation: tr };
}

/** Real stats for given run lengths: one "x" per run, runs split by ". ". */
function fromLengths(lengths: number[]): RunStats {
  const text = lengths.map(() => 'x').join('. ');
  const kept = lengths.map((n, i) => ({
    start: i * 3, end: i * 3 + 1, cognate: false, translation: Array(n).fill('ab').join(' '),
  }));
  const s = runStats(text, kept, 'it');
  expect(s.lengths).toEqual(lengths);
  return s;
}

describe('runStats: what makes a run', () => {
  it('a source word between two swaps makes two runs', () => {
    const t = 'Juan come pan y bebe agua.';
    const s = runStats(t, [k(t, 'come pan', 'mangia pane'), k(t, 'bebe agua', 'beve acqua')], 'it');
    expect(s).toMatchObject({ runs: 2, median: 2, max: 2, words: 4, lengths: [2, 2] });
  });

  it.each([
    ['comma and space', 'Compró pan, leche y fruta.', ', '],
    ['space only', 'Compró pan leche y fruta.', ' '],
    ['nothing between', 'Compró panleche y fruta.', ''],
    ['comma, tab and space', 'Compró pan ,\tleche y fruta.', ' ,\t'],
  ])('adjacent items joined by %s are ONE run (learning #1)', (_n, t) => {
    const pan = k(t, 'pan', 'pane');
    const leche = k(t, 'leche', 'latte', false, pan.end);
    const s = runStats(t, [pan, leche], 'it');
    expect(s).toMatchObject({ runs: 1, median: 2, max: 2, lengths: [2] });
  });

  it('splitting one clause into more adjacent items does not shorten the run', () => {
    const t = 'ella compró pan fresco ayer';
    const whole = runStats(t, [k(t, 'compró pan fresco', 'comprò pane fresco')], 'it');
    const split = runStats(
      t,
      [k(t, 'compró', 'comprò'), k(t, 'pan', 'pane'), k(t, 'fresco', 'fresco x')],
      'it',
    );
    expect(whole.lengths).toEqual([3]);
    expect(split.lengths).toEqual([4]);
    expect(split.runs).toBe(1);
  });

  it('a period breaks a run', () => {
    const t = 'Comió pan. Bebió agua.';
    const s = runStats(t, [k(t, 'Comió pan', 'Mangiò pane'), k(t, 'Bebió agua', 'Bevve acqua')], 'it');
    expect(s.runs).toBe(2);
  });

  it.each([';', '—', '"', '(', ':'])('%s breaks a run', ch => {
    const t = `pan${ch} agua`;
    expect(runStats(t, [k(t, 'pan', 'pane'), k(t, 'agua', 'acqua')], 'it').runs).toBe(2);
  });

  it('a newline breaks a run; tab/comma do not', () => {
    const nl = 'pan\nagua';
    expect(runStats(nl, [k(nl, 'pan', 'pane'), k(nl, 'agua', 'acqua')], 'it').runs).toBe(2);
    const crlf = 'pan,\r\nagua';
    expect(runStats(crlf, [k(crlf, 'pan', 'pane'), k(crlf, 'agua', 'acqua')], 'it').runs).toBe(2);
    const ok = 'pan ,\tagua';
    expect(runStats(ok, [k(ok, 'pan', 'pane'), k(ok, 'agua', 'acqua')], 'it').runs).toBe(1);
  });

  it.each([
    ['NBSP', 1, '\u00a0'],
    ['narrow NBSP', 1, '\u202f'],
    ['ideographic space', 1, '\u3000'],
    ['em space', 1, '\u2003'],
    ['space-comma', 1, ' ,'],
    ['double comma', 1, ',,'],
    ['CR', 2, '\r'],
    ['VT', 2, '\v'],
    ['FF', 2, '\f'],
    ['line separator', 2, '\u2028'],
    ['paragraph separator', 2, '\u2029'],
    ['NEL', 2, '\u0085'],
    ['zero-width space', 2, '\u200b'],
    ['apostrophe', 2, "'"],
    ['ideographic comma', 2, '、'],
  ])('gap of %s gives %i run(s)', (_n, runs, gap) => {
    const t = `pan${gap}agua`;
    expect(runStats(t, [k(t, 'pan', 'pane'), k(t, 'agua', 'acqua')], 'it').runs).toBe(runs);
  });

  it('a cognate is excluded from the words and breaks the run', () => {
    const t = 'come una paella enorme ahora';
    const s = runStats(
      t,
      [k(t, 'come', 'mangia'), k(t, 'una paella enorme', 'una paella enorme', true), k(t, 'ahora', 'adesso')],
      'it',
    );
    expect(s).toMatchObject({ runs: 2, lengths: [1, 1], words: 2 });
  });

  it('only cognates, or nothing at all: no runs', () => {
    const t = 'una paella';
    expect(runStats(t, [k(t, 'una paella', 'una paella', true)], 'it')).toMatchObject({ runs: 0, words: 0, median: 0, max: 0 });
    expect(runStats('', [], 'it')).toEqual({ runs: 0, words: 0, median: 0, max: 0, over: { 4: 0, 8: 0 }, lengths: [] });
  });

  it('is independent of the order of kept', () => {
    const t = 'Juan come pan y bebe agua.';
    const a = k(t, 'come pan', 'mangia pane');
    const b = k(t, 'bebe agua', 'beve acqua');
    expect(runStats(t, [b, a], 'it')).toEqual(runStats(t, [a, b], 'it'));
  });

  it('does not mutate its input', () => {
    const t = 'pan y agua';
    const kept = [k(t, 'agua', 'acqua'), k(t, 'pan', 'pane')];
    runStats(t, kept, 'it');
    expect(kept[0].translation).toBe('acqua');
  });
});

describe('runStats: length uses the tokenizer on the translation', () => {
  it.each([
    ['el agua', "l'acqua", 'it', 1],
    ['la casa', 'the house', 'en', 2],
    ['el tren de las 8:15', 'il treno delle 8:15', 'it', 4],
  ])('%s → %s is %i word(s)', (src, tr, loc, n) => {
    const t = `x ${src} y`;
    expect(runStats(t, [k(t, src, tr)], loc).lengths).toEqual([n]);
  });
});

describe('runStats: median, max, over', () => {
  it.each([
    [[1, 2, 3, 10], 2.5],
    [[5], 5],
    [[3, 1, 2], 2],
    [[], 0],
  ])('median of %j is %d', (l, m) => {
    expect(fromLengths(l).median).toBe(m);
  });

  it('over[4] and over[8] are shares of runs', () => {
    const s = fromLengths([1, 5, 9, 9]);
    expect(s.over).toEqual({ 4: 0.75, 8: 0.5 });
    expect(s.max).toBe(9);
    expect(s.words).toBe(24);
  });

  it('"longer than" is strict: a run of exactly 4 is not over 4', () => {
    expect(fromLengths([4, 4]).over).toEqual({ 4: 0, 8: 0 });
  });
});

describe('checkRunShape', () => {
  const ten = (...over: number[]) => [...over, ...Array(10 - over.length).fill(1)];

  it('exports the rules as data', () => {
    expect(LENGTH_RULES).toEqual({
      1: { maxWords: 4, maxShareOver: 0.1, maxMedian: 3 },
      2: { maxWords: 8, maxShareOver: 0.3, maxMedian: 6 },
      3: null,
    });
  });

  it('L1: 25% over 4 words fails', () => {
    const r = checkRunShape(fromLengths([1, 2, 3, 5]), 1);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/25% of runs over 4 words/);
  });
  it('L1: all short passes', () => {
    expect(checkRunShape(fromLengths([1, 2, 2, 3]), 1)).toEqual({ ok: true, violations: [] });
  });
  it('L1 boundary: exactly 10% over 4 passes, 20% fails', () => {
    expect(checkRunShape(fromLengths(ten(5)), 1).ok).toBe(true);
    expect(checkRunShape(fromLengths(ten(5, 5)), 1).ok).toBe(false);
  });
  it('L1 median boundary: 3 passes, 3.5 fails', () => {
    expect(checkRunShape(fromLengths([3, 3, 3]), 1).ok).toBe(true);
    const r = checkRunShape(fromLengths([3, 4]), 1);
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toMatch(/median run 3.5/);
  });

  it('L2: median 7 fails', () => {
    const r = checkRunShape(fromLengths([7, 7, 7]), 2);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/median run 7 words \(max 6\)/);
  });
  it('L2 boundary: exactly 30% over 8 passes, 40% fails', () => {
    expect(checkRunShape(fromLengths(ten(9, 9, 9)), 2).ok).toBe(true);
    expect(checkRunShape(fromLengths(ten(9, 9, 9, 9)), 2).ok).toBe(false);
  });
  it('L2 median boundary: 6 passes, 6.5 fails', () => {
    expect(checkRunShape(fromLengths([6, 6]), 2).ok).toBe(true);
    expect(checkRunShape(fromLengths([6, 7]), 2).ok).toBe(false);
  });
  it('L2 run of exactly 8 is not over 8', () => {
    expect(checkRunShape(fromLengths([4, 8, 5]), 2).ok).toBe(true);
  });
  it('reports both violations', () => {
    expect(checkRunShape(fromLengths([9, 9]), 2).violations).toHaveLength(2);
  });

  it('L3 always passes', () => {
    expect(checkRunShape(fromLengths([40, 50, 60]), 3)).toEqual({ ok: true, violations: [] });
  });
  it('no runs passes at every level', () => {
    for (const l of [1, 2, 3] as const) expect(checkRunShape(runStats('', [], 'it'), l).ok).toBe(true);
  });
});

describe('formatRunStats', () => {
  it('prints one line with the rule and verdict', () => {
    const s = fromLengths([9, 9, 3]);
    expect(formatRunStats(s, 2)).toBe('runs 3 · median 9 · >8w 67% (L2 ≤30%) · max 9 · shape FAIL');
    expect(formatRunStats(fromLengths([1, 2]), 1)).toBe('runs 2 · median 1.5 · >4w 0% (L1 ≤10%) · max 2 · shape ok');
  });
  it('L3 is free; empty input still formats', () => {
    expect(formatRunStats(fromLengths([12]), 3)).toBe('runs 1 · median 12 · max 12 · shape free');
    expect(formatRunStats(runStats('', [], 'it'), 2)).toBe('runs 0 · median 0 · >8w 0% (L2 ≤30%) · max 0 · shape ok');
  });
});
