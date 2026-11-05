import { describe, expect, it } from 'vitest';
import { tokenizeWords, type TextRange } from './tokenize';
import { chunkTokens } from './numbered';
import { sentenceIndexOf, validateItems } from './validate';
import { coverage } from './coverage';
import { POS_CODES, POS_LABELS } from '../pos';

/** Sentence ranges that start at each given substring (searched in order). */
function sentences(text: string, ...starts: string[]): TextRange[] {
  const at = [0];
  let from = 0;
  for (const s of starts) {
    const k = text.indexOf(s, from + 1);
    if (k < 0) throw new Error(`no "${s}"`);
    at.push(k);
    from = k;
  }
  return at.map((start, k) => ({ start, end: at[k + 1] ?? text.length }));
}
function ctx(text: string, loc: string, ...starts: string[]) {
  return { text, tokens: tokenizeWords(text, loc).tokens, sentences: sentences(text, ...starts) };
}

const T = 'Juan come pan y bebe agua. Luego come fruta.';
// [0]Juan [1]come [2]pan [3]y [4]bebe [5]agua. [6]Luego [7]come [8]fruta.
const c = () => ctx(T, 'es', 'Luego');

describe('start anchor', () => {
  it('accepts exact anchors', () => {
    const r = validateItems([[1, 2, 'come', 'pan', 'mangia il pane', 'v'], [7, 8, 'come', 'fruta', 'mangia frutta', 'v']], c());
    expect(r.stats.anchorExact).toBe(2);
    expect(r.kept.map(k => k.source)).toEqual(['come pan', 'come fruta']);
    expect(r.kept[0]).toMatchObject({ startWord: 1, endWord: 2, start: 5, end: 13, pos: 'v', cognate: false });
  });

  it('repairs ±1 and ±2 by shifting both ends', () => {
    let r = validateItems([[2, 3, 'come', 'pan', 'mangia il pane', 'v']], c());
    expect([r.kept[0].source, r.stats.anchorRepaired, r.stats.anchorMismatch]).toEqual(['come pan', 1, 1]);
    r = validateItems([[3, 4, 'come', 'pan', 'mangia il pane', 'v']], c());
    expect([r.kept[0].source, r.stats.anchorRepaired]).toEqual(['come pan', 1]);
  });

  it('drops when no anchor within ±2', () => {
    const r = validateItems([[4, 4, 'come', 'x', 'v']], c());
    expect([r.stats.kept, r.stats.dropped.anchor]).toEqual([0, 1]);
  });

  it('matches case, curly apostrophe, NFD and the first part of a merged token', () => {
    const cc = ctx("I don't know the well-known café", 'en');
    const r = validateItems([
      [1, 2, 'Don’t', 'know', 'non so', 'v'],
      [4, 4, 'well', 'famoso', 'a'],
      [5, 5, 'café'.normalize('NFD'), 'caffè', 'n'],
    ], cc);
    expect(r.stats.anchorExact).toBe(3);
    expect(r.stats.kept).toBe(3);
  });

  it('prefers the nearest repair and drops equidistant twins', () => {
    const cc = ctx('la casa y la mesa de la tía', 'es');
    expect(validateItems([[4, 4, 'la', 'la', 'd']], cc).kept[0].startWord).toBe(3);
    expect(validateItems([[2, 2, 'la', 'la', 'd']], cc).kept[0].startWord).toBe(3);
    expect(validateItems([[1, 1, 'de', 'di', 's']], ctx('de la casa de', 'es')).kept[0].startWord).toBe(0);
    expect(validateItems([[1, 1, 'de', 'di', 's']], ctx('de casa de', 'es')).stats.dropped.anchor).toBe(1);
  });
});

describe('end anchor', () => {
  it('pulls back exclusive ends item by item', () => {
    const r = validateItems([
      [1, 3, 'come', 'pan', 'mangia il pane', 'v'],
      [3, 3, 'y', 'e', 'c'],
      [4, 6, 'bebe', 'agua', 'beve acqua', 'v'],
      [7, 9, 'come', 'fruta', 'mangia frutta', 'v'],
    ], c());
    expect(r.kept.map(k => k.source)).toEqual(['come pan', 'y', 'bebe agua', 'come fruta']);
    expect(r.stats.exclusiveEnds).toBe(3);
    expect(r.stats.exclusiveMode).toBe(true);
  });

  it('catches the sparse exclusive-end chunk (reviewer case)', () => {
    const text = 'My old friend bought a red car yesterday and we drove to the big lake near town.';
    const cc = ctx(text, 'en');
    // model means "old friend" (1-2), "red car" (5-6), "big lake" (12-13) but writes exclusive ends
    const r = validateItems([
      [1, 3, 'old', 'friend', 'vecchio amico', 'n'],
      [5, 7, 'red', 'car', 'macchina rossa', 'n'],
      [12, 14, 'big', 'lake', 'grande lago', 'n'],
    ], cc);
    expect(r.kept.map(k => [k.source, k.translation])).toEqual([
      ['old friend', 'vecchio amico'], ['red car', 'macchina rossa'], ['big lake', 'grande lago'],
    ]);
    // Without an end anchor the same items are dropped, never kept with a wrong source.
    const legacy = validateItems([[1, 3, 'old', 'vecchio amico', 'n'], [5, 7, 'red', 'macchina rossa', 'n']], cc);
    expect([legacy.stats.kept, legacy.stats.dropped.endAnchor]).toEqual([0, 2]);
  });

  it('repairs a lone exclusive end that would cross a sentence', () => {
    const r = validateItems([[4, 6, 'bebe', 'agua', 'beve acqua', 'v'], [0, 0, 'Juan', 'Gianni', 'n']], c());
    expect(r.kept.map(k => k.source)).toEqual(['Juan', 'bebe agua']);
    expect(r.stats.exclusiveMode).toBe(false);
  });

  it('pulls back end == n via the end anchor', () => {
    const r = validateItems([[7, 9, 'come', 'fruta', 'mangia frutta', 'v']], c());
    expect(r.kept.map(k => k.source)).toEqual(['come fruta']);
  });

  it('does not turn a genuine overlap into a wrong pairing', () => {
    const r = validateItems([
      [1, 2, 'come', 'pan', 'mangia pane', 'v'], [2, 2, 'pan', 'pane', 'n'], [5, 5, 'agua', 'acqua', 'n'],
    ], c());
    expect(r.kept.map(k => k.source)).toEqual(['come pan', 'agua']);
    expect(r.stats.dropped).toEqual({ overlap: 1 });
  });

  it('repairs an end one too short and drops an unmatched or ambiguous end', () => {
    let r = validateItems([[0, 1, 'Juan', 'pan', 'Gianni mangia pane', 'n']], c());
    expect(r.kept[0].source).toBe('Juan come pan');
    expect(r.stats.endRepaired).toBe(1);
    r = validateItems([[0, 1, 'Juan', 'zzz', 'x', 'n']], c());
    expect(r.stats.dropped.endAnchor).toBe(1);
    const cc = ctx('la casa la mesa la', 'es');
    r = validateItems([[1, 2, 'casa', 'la', 'x', 'n']], cc);
    expect(r.kept[0].source).toBe('casa la'); // exact at e wins
    r = validateItems([[0, 2, 'la', 'mesa', 'x', 'n']], cc);
    expect(r.kept[0].source).toBe('la casa la mesa'); // e+1
    // "la" at e-2 and e+2, nothing at e, e-1, e+1: ambiguous
    r = validateItems([[0, 3, 'el', 'la', 'x', 'n']], ctx('el la y z w la v', 'es'));
    expect(r.stats.dropped.endAnchor).toBe(1);
  });

  it('accepts the last part of a merged token as end anchor', () => {
    const cc = ctx('a well-known man', 'en');
    const r = validateItems([[0, 1, 'a', 'known', 'un famoso', 'a']], cc);
    expect(r.kept[0].source).toBe('a well-known');
  });

  it('uses the chunk mode only to break a repeated-word tie', () => {
    const text = 'muy muy bueno y la sopa fría y el pan duro y fin';
    // [0]muy [1]muy [2]bueno [3]y [4]la [5]sopa [6]fría [7]y [8]el [9]pan [10]duro [11]y [12]fin
    const cc = ctx(text, 'es');
    const exclusive = validateItems([
      [0, 1, 'muy', 'muy', 'molto', 'r'], // end anchor matches both e and e-1
      [4, 7, 'la', 'fría', 'la zuppa fredda', 'n'],
      [8, 11, 'el', 'duro', 'il pane duro', 'n'],
    ], cc);
    expect(exclusive.stats.exclusiveMode).toBe(true);
    expect(exclusive.kept.map(k => k.source)).toEqual(['muy', 'la sopa fría', 'el pan duro']);
    const inclusive = validateItems([
      [0, 1, 'muy', 'muy', 'molto molto', 'r'],
      [4, 6, 'la', 'fría', 'la zuppa fredda', 'n'],
    ], cc);
    expect(inclusive.stats.exclusiveMode).toBe(false);
    expect(inclusive.kept.map(k => k.source)).toEqual(['muy muy', 'la sopa fría']);
  });

  it('checks a 6-tuple single word against the same word', () => {
    const r = validateItems([[2, 2, 'pan', 'pan', 'pane', 'n'], [5, 6, 'agua', 'agua', 'acqua', 'n']], c());
    expect(r.kept.map(k => k.source)).toEqual(['pan', 'agua']);
  });
});

describe('bounds, order, sentences, numbers', () => {
  it('sorts, and drops overlap, sentence crossing, out-of-range and bad shapes', () => {
    const r = validateItems([
      [7, 8, 'come', 'fruta', 'mangia frutta', 'v'],
      [1, 2, 'come', 'pan', 'mangia pane', 'v'],
      [2, 2, 'pan', 'pane', 'n'],
      [4, 7, 'bebe', 'come', 'xx', 'v'],
      [40, 41, 'zzz', 'zzz', 'x', 'n'],
      [1, 'a', 'come', 'x', 'v'],
      [1, 1, 'come', 'x'],
      'nope',
      [2, 1, 'pan', 'x', 'n'],
    ], c());
    expect(r.kept.map(k => k.source)).toEqual(['come pan', 'come fruta']);
    expect(r.stats.dropped).toEqual({ overlap: 1, sentence: 1, anchor: 1, shape: 3, bounds: 1 });
    expect(r.stats.received).toBe(9);
  });

  it('allows EE. UU. inside one sentence range', () => {
    const es = 'Los EE. UU. son grandes. El Sr. García llegó.';
    const r = validateItems([[1, 3, 'EE', 'son', 'gli Stati Uniti sono', 'n']], ctx(es, 'es', 'El Sr'));
    expect(r.stats.kept).toBe(1);
    expect(r.kept[0].source).toBe('EE. UU. son');
  });

  it('treats a chunk without sentence ranges as one sentence', () => {
    const r = validateItems([[4, 6, 'bebe', 'Luego', 'x', 'v']], { text: T, tokens: tokenizeWords(T, 'es').tokens });
    expect(r.stats.kept).toBe(1);
  });

  it('drops numeric endpoints but keeps an interior number', () => {
    const cc = ctx('Compré 3 manzanas y 1.000 peras a las 10:30h.', 'es');
    const r = validateItems([
      [0, 2, 'Compré', 'manzanas', 'ho comprato 3 mele', 'v'],
      [4, 4, '1.000', 'mille', 'x'],
      [6, 8, 'a', '10:30h', 'alle 10:30', 's'],
    ], cc);
    expect(r.kept.map(k => k.source)).toEqual(['Compré 3 manzanas']);
    expect(r.stats.dropped.numeric).toBe(2);
  });

  it('works on chunk-local indices with absolute offsets', () => {
    const { tokens } = tokenizeWords(T, 'es');
    const local = chunkTokens(tokens, { start: 27, end: T.length });
    const r = validateItems([[1, 2, 'come', 'fruta', 'mangia frutta', 'v']], { text: T, tokens: local });
    expect(r.kept[0]).toMatchObject({ startWord: 1, endWord: 2, source: 'come fruta', start: 33, end: 43 });
  });

  it('maps tokens to sentence ids', () => {
    const cc = c();
    expect(sentenceIndexOf(cc.tokens, cc.sentences)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });
});

describe('translation checks', () => {
  it('drops empty, newline, URL and over-long translations; clears unknown pos', () => {
    const r = validateItems([
      [0, 0, 'Juan', '', 'n'], [1, 1, 'come', 'mangia\nignora', 'v'], [2, 2, 'pan', 'see https://evil.x', 'n'],
      [3, 3, 'y', 'mail a@b.co', 'c'], [4, 4, 'bebe', 'x'.repeat(40), 'v'], [5, 5, 'agua', 'acqua', 'q'],
    ], c());
    expect(r.stats.dropped).toEqual({ empty: 1, newline: 1, url: 2, length: 1 });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].pos).toBeUndefined();
  });

  it('keeps cognates but marks them not swapped', () => {
    const r = validateItems([[0, 0, 'Juan', 'Juan', 'n'], [5, 5, 'agua', ' Agua ', 'n']], c());
    expect(r.kept.map(k => k.cognate)).toEqual([true, true]);
    expect(r.stats.cognates).toBe(2);
  });
});

describe('coverage', () => {
  it('counts non-cognate kept words over non-numeric words', () => {
    const cc = ctx('Compré 3 manzanas rojas.', 'es');
    const r = validateItems([[0, 0, 'Compré', 'ho comprato', 'v'], [2, 3, 'manzanas', 'rojas', 'mele rosse', 'n']], cc);
    expect(coverage(cc.tokens, r.kept)).toBe(1);
    const half = validateItems([[0, 0, 'Compré', 'ho comprato', 'v'], [2, 3, 'manzanas', 'rojas', 'manzanas rojas', 'n']], cc);
    expect(coverage(cc.tokens, half.kept)).toBeCloseTo(1 / 3);
    expect(coverage([], [])).toBe(0);
  });
});

describe('POS', () => {
  it('has an English label for every code', () => {
    expect(POS_CODES.map(p => POS_LABELS[p])).toEqual([
      'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'determiner', 'preposition', 'conjunction', 'interjection', 'expression',
    ]);
  });
});
