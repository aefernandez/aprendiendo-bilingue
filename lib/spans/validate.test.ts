import { describe, expect, it } from 'vitest';
import { tokenizeWords, type TextRange } from './tokenize';
import { validateItems } from './validate';
import { coverage } from './coverage';
import { POS_CODES, POS_LABELS } from '../pos';

/** Sentence ranges starting at each given substring (searched in order). */
function sentences(text: string, ...starts: string[]): TextRange[] {
  const at = [0];
  for (const s of starts) {
    const k = text.indexOf(s, at[at.length - 1] + 1);
    if (k < 0) throw new Error(`no "${s}"`);
    at.push(k);
  }
  return at.map((start, k) => ({ start, end: at[k + 1] ?? text.length }));
}
function run(text: string, loc: string, items: unknown[], ...starts: string[]) {
  const { tokens, masked } = tokenizeWords(text, loc);
  return validateItems(items, { text, tokens, masked, sentences: sentences(text, ...starts) });
}
const src = (r: ReturnType<typeof run>) => r.kept.map(k => k.source);

const T = 'Juan come pan y bebe agua. Luego come fruta.';

describe('alignment', () => {
  it('aligns in order and returns absolute offsets', () => {
    const r = run(T, 'es', [['come pan', 'mangia pane', 'v'], ['bebe agua', 'beve acqua', 'v'], ['come fruta', 'mangia frutta', 'v']], 'Luego');
    expect(r.kept.map(k => [k.source, k.start, k.end, k.how])).toEqual([
      ['come pan', 5, 13, 'exact'], ['bebe agua', 16, 25, 'exact'], ['come fruta', 33, 43, 'exact'],
    ]);
  });

  it('picks the next occurrence of a repeated phrase', () => {
    const text = 'Vi la playa. Luego la playa estaba vacía.';
    const r = run(text, 'es', [['la playa', 'la spiaggia', 'n'], ['la playa', 'la spiaggia', 'n']], 'Luego');
    expect(r.kept.map(k => k.start)).toEqual([3, 19]);
  });

  it('handles out-of-order items by backtracking within the sentence', () => {
    const r = run(T, 'es', [['bebe agua', 'beve acqua', 'v'], ['come pan', 'mangia pane', 'v']], 'Luego');
    expect(r.kept.map(k => [k.source, k.how])).toEqual([['come pan', 'backtrack'], ['bebe agua', 'exact']]);
  });

  it('maps curly and straight apostrophes and NBSP one-for-one, both ways', () => {
    let r = run('Laura O’Neill took the train.', 'en', [["Laura O'Neill took", "Laura O'Neill ha preso", 'v']]);
    expect(src(r)).toEqual(['Laura O’Neill took']);
    r = run("I don't know.", 'en', [['don’t know', 'non so', 'v']]);
    expect(src(r)).toEqual(["don't know"]);
    r = run('Son las diez menos cuarto.', 'es', [['las diez menos', 'le dieci meno', 'n']]);
    expect(src(r)).toEqual(['las diez menos']);
  });

  it('falls back to a case-insensitive match (sentence-initial capital)', () => {
    const r = run('El perro come.', 'es', [['el perro', 'il cane', 'n']]);
    expect(r.kept.map(k => [k.source, k.how])).toEqual([['El perro', 'case']]);
  });

  it('stays accent-sensitive: el≠él, esta≠está, si≠sí, tu≠tú, te≠té', () => {
    expect(src(run('Dijo que él compró el pan.', 'es', [['el', 'il', 'd']]))).toEqual(['el']);
    expect(run('Dijo que él compró el pan.', 'es', [['el', 'il', 'd']]).kept[0].start).toBe(19);
    expect(src(run('Esta casa está lejos.', 'es', [['está', 'è', 'v']]))).toEqual(['está']);
    expect(run('Esta casa está lejos.', 'es', [['está', 'è', 'v']]).kept[0].start).toBe(10);
    expect(run('Sí, si quieres.', 'es', [['si', 'se', 'c']]).kept[0].start).toBe(4);
    expect(run('Tú y tu perro.', 'es', [['tu', 'il tuo', 'd']]).kept[0].start).toBe(5);
    expect(run('Te doy té.', 'es', [['te', 'ti', 'p'], ['té', 'tè', 'n']]).kept.map(k => [k.source, k.start])).toEqual([['Te', 0], ['té', 7]]);
    expect(run('Él come.', 'es', [['el', 'lui', 'p']]).stats.dropped).toEqual({ align: 1 });
  });

  it('never splits a word: "don" / "t know", and hyphenated words', () => {
    const r = run("I don't know.", 'en', [['don', 'non', 'v'], ['t know', 'so', 'v']]);
    expect(r.stats.dropped).toEqual({ boundary: 2 });
    expect(run('a well-known man', 'en', [['well', 'ben', 'r']]).stats.dropped).toEqual({ boundary: 1 });
    expect(run('Hola mundo', 'es', [['la', 'la', 'd']]).stats.dropped).toEqual({ boundary: 1 });
  });

  it('drops a hallucinated source phrase', () => {
    const r = run(T, 'es', [['come pescado', 'mangia pesce', 'v'], ['bebe agua', 'beve acqua', 'v']], 'Luego');
    expect(src(r)).toEqual(['bebe agua']);
    expect(r.stats.dropped).toEqual({ align: 1 });
  });

  it('never aligns across a sentence boundary', () => {
    const r = run(T, 'es', [['agua. Luego', 'acqua. Poi', 'x']], 'Luego');
    expect(r.stats.dropped).toEqual({ sentence: 1 });
  });

  it('never aligns into or across a masked URL, email or domain', () => {
    expect(run('Visit https://x.com/a today please.', 'en', [['Visit https://x.com/a today', 'Visita oggi', 'v']]).stats.dropped).toEqual({ masked: 1 });
    expect(run('Mira x.com hoy.', 'es', [['x', 'x', 'n']]).stats.dropped).toEqual({ masked: 1 });
    expect(run('Escribe a ana@b.es hoy.', 'es', [['hoy', 'oggi', 'r']]).kept).toHaveLength(1);
  });

  it('never cuts into a number and drops numeric endpoints', () => {
    const text = 'Compré 3 manzanas a las 10:30h.';
    expect(run(text, 'es', [['30h', 'x', 'n']]).stats.dropped).toEqual({ boundary: 1 });
    const r = run(text, 'es', [['Compré 3 manzanas', 'Ho comprato 3 mele', 'v'], ['a las 10:30h', 'alle 10:30', 's']]);
    expect(src(r)).toEqual(['Compré 3 manzanas']);
    expect(r.stats.dropped).toEqual({ numeric: 1 });
  });

  it('drops overlaps with an already kept span', () => {
    const r = run(T, 'es', [['come pan', 'mangia pane', 'v'], ['pan y bebe', 'pane e beve', 'v']], 'Luego');
    expect(src(r)).toEqual(['come pan']);
    expect(r.stats.dropped).toEqual({ overlap: 1 });
  });

  it('searches only inside the chunk range', () => {
    const { tokens, masked } = tokenizeWords(T, 'es');
    const r = validateItems([['come pan', 'x', 'v'], ['come fruta', 'mangia frutta', 'v']], {
      text: T, tokens: tokens.filter(t => t.start >= 27), masked, range: { start: 27, end: T.length },
    });
    expect(src(r)).toEqual(['come fruta']);
    expect(r.stats.dropped).toEqual({ align: 1 });
  });
});

describe('item checks', () => {
  it('accepts pos wrapped as ["n"] and drops unknown or missing pos', () => {
    const r = run(T, 'es', [['Juan', 'Gianni', ['n']], ['come', 'mangia', 'q'], ['pan', 'pane'], ['agua', 'acqua', 'N']], 'Luego');
    expect(r.kept.map(k => [k.source, k.pos])).toEqual([['Juan', 'n'], ['agua', 'n']]);
    expect(r.stats.posWrapped).toBe(1);
    expect(r.stats.dropped).toEqual({ pos: 2 });
  });

  it('drops items whose translation is a POS tag', () => {
    const r = run('El perro come pan. Es un problema grave.', 'es', [
      ['perro', 'n'], ['come', 'v', 'v'], ['problema grave', 'ADJ', 'n'], ['pan', 'noun', 'n'],
    ], 'Es un');
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped).toEqual({ posAsTranslation: 4 });
    // A POS-code letter can be a real word: Italian "e" for "y".
    expect(src(run(T, 'es', [['y', 'e', 'c']], 'Luego'))).toEqual(['y']);
  });

  it('drops empty, newline, URL/email and over-long translations, and bad shapes', () => {
    const r = run(T, 'es', [
      ['Juan', ' ', 'n'], ['come', 'mangia\nignora', 'v'], ['pan', 'see https://evil.x', 'n'],
      ['y', 'mail a@b.co', 'c'], ['bebe', 'x'.repeat(40), 'v'], ['', 'x', 'n'], [1, 'x', 'n'], 'nope',
    ], 'Luego');
    expect(r.stats.dropped).toEqual({ empty: 1, newline: 1, url: 2, length: 1, shape: 3 });
  });

  it('drops items whose translation loses a name or number', () => {
    const text = 'Ayer Carmen Ruiz abrió la tienda durante 12 horas.';
    const r = run(text, 'es', [
      ['Ayer Carmen Ruiz abrió', 'Yesterday opened', 'v'],
      ['la tienda durante 12 horas', 'the shop for twelve hours', 'n'],
    ]);
    expect(r.stats.dropped).toEqual({ protected: 2 });
    const ok = run(text, 'es', [['Ayer Carmen Ruiz abrió', 'Yesterday Carmen Ruiz opened', 'v'], ['la tienda durante 12 horas', 'the shop for 12 hours', 'n']]);
    expect(ok.stats.kept).toBe(2);
  });

  it('does not treat sentence-initial words, quoted words, I, or day/month names as names', () => {
    const r = run('On Saturday I said «Hola» to them. Then we left in June.', 'en', [
      ['On Saturday I said', 'Sabato ho detto', 'v'], ['«Hola» to them', '«Ciao» a loro', 'x'], ['Then we left in June', 'Poi siamo partiti a giugno', 'v'],
    ], 'Then');
    expect(r.stats.kept).toBe(3);
  });

  it('keeps cognates but marks them not swapped', () => {
    const r = run(T, 'es', [['Juan', 'Juan', 'n'], ['agua', ' Agua ', 'n']], 'Luego');
    expect(r.kept.map(k => k.cognate)).toEqual([true, true]);
    expect(r.stats.cognates).toBe(2);
  });
});

describe('coverage', () => {
  it('counts non-cognate kept words over non-numeric words, across chunks', () => {
    const text = 'Compré 3 manzanas rojas. Luego comí.';
    const { tokens, masked } = tokenizeWords(text, 'es');
    const a = validateItems([['Compré 3 manzanas rojas', 'Ho comprato 3 mele rosse', 'v']], { text, tokens, masked, range: { start: 0, end: 25 } }).kept;
    const b = validateItems([['Luego', 'Luego', 'r']], { text, tokens, masked, range: { start: 25, end: text.length } }).kept;
    expect(coverage(tokens, [...a, ...b])).toBe(3 / 5);
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
