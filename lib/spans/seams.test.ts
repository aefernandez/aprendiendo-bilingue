import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitSentences } from '../chunker';
import { PASSAGES } from './__fixtures__/spike/passages';
import { parseItems } from './parse';
import type { SourceLang, TargetLang } from './seams';
import { tokenizeWords, type TextRange } from './tokenize';
import { validateItems } from './validate';

function run(text: string, loc: string, items: unknown[], langs?: { s: SourceLang; t: TargetLang }) {
  const { tokens, masked } = tokenizeWords(text, loc);
  const r = validateItems(items, {
    text, tokens, masked, sentences: splitSentences(text, loc),
    ...(langs ? { sourceLang: langs.s, targetLang: langs.t } : {}),
  });
  // Every kept range still slices the original text verbatim.
  for (const k of r.kept) expect(text.slice(k.start, k.end)).toBe(k.source);
  return r;
}
const pairs = (r: ReturnType<typeof run>) => r.kept.map(k => [k.source, k.translation]);

describe('doubled punctuation at the seam', () => {
  it.each([
    ['comma after', 'Well, she said, it was late.', ['Well', 'Bueno,', 'i'], 'Bueno'],
    ['period after', 'It was very late. Then.', ['very late', 'muy tarde.', 'r'], 'muy tarde'],
    ['ellipsis vs period', 'It was very late... Then.', ['very late', 'muy tarde…', 'r'], 'muy tarde'],
    ['quotes around', 'He said "hello" to me.', ['hello', '"hola"', 'i'], 'hola'],
    ['quote kinds are one class', 'He said "hello" to me.', ['hello', '«hola»', 'i'], 'hola'],
    ['curly quotes', 'He said “hello” to me.', ['hello', '"hola"', 'i'], 'hola'],
    ['dash before', 'It was late — very late.', ['very late', '— muy tarde', 'r'], 'muy tarde'],
    ['en dash vs em dash', 'It was late — very late.', ['very late', '– muy tarde', 'r'], 'muy tarde'],
    ['spaced hyphen as dash', 'It was late - very late.', ['very late', '— muy tarde', 'r'], 'muy tarde'],
    ['¿ and ? at both ends', '¿Dónde está el baño?', ['Dónde está el baño', '¿Where is the bathroom?', 'x'], 'Where is the bathroom'],
    ['¡ and !', '¡Qué bonito día!', ['Qué bonito día', '¡What a lovely day!', 'x'], 'What a lovely day'],
    ['question mark only', 'Is this the house?', ['the house', 'la casa?', 'n'], 'la casa'],
    ['only the doubled quote goes', 'He said "hello" to me.', ['hello', '"hola', 'i'], 'hola'],
    ['quotes around an elision', 'Dijo "un poco" ayer.', ['un poco', "\"un po'\"", 'r'], "un po'"],
    ['inner punctuation stays', 'Well, she said, it was late.', ['it was late', 'era tarde, ya.', 'x'], 'era tarde, ya'],
  ])('%s', (_label, text, item, expected) => {
    const r = run(text, text.includes('¿') || text.includes('¡') ? 'es' : 'en', [item]);
    expect(r.kept.map(k => k.translation)).toEqual([expected]);
    expect(r.stats.repaired).toEqual({ punct: 1, determiner: 0 });
  });

  it.each([
    ['source owns the punctuation', '«Dámelo», dice.', ['«Dámelo»', "'Give it to me'", 'x']],
    ['comma not doubled', 'Well, she said.', ['she said', 'dijo,', 'v']],
    ['comma after, translation ends with a period', 'Well, she said.', ['Well', 'Bueno.', 'i']],
    ['elision before a closing quote', 'Dijo "un poco" ayer.', ['un poco', "un po'", 'r']],
    ['elision before a closing single quote', "Dijo 'poco' ayer.", ['poco', "po'", 'r']],
    ['brackets unbalanced after the strip', 'Vino (ayer) tarde.', ['ayer', 'ieri (forse))', 'r']],
    ['aphaeresis at the start', "He said 'twas cold.", ['twas cold', "'na fredda", 'x']],
    ['closing quote before is not an opener', 'He said "go" now.', ['now', '"ora"', 'r']],
    ['hyphen inside a word', 'It was late -ish.', ['ish', '-oso', 'x']],
  ])('no repair: %s', (_label, text, item) => {
    const r = run(text, 'es', [item]);
    expect(r.kept.map(k => k.translation)).toEqual([String(item[1]).trim()]);
    expect(r.stats.repaired.punct).toBe(0);
  });

  it('drops as empty when nothing is left', () => {
    const r = run('Well, she said.', 'en', [['Well', ',', 'i'], ['she said', '.', 'v']]);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped).toEqual({ empty: 2 });
  });

  it('looks across the sentence end only for characters that cannot start a sentence', () => {
    // The period after "late" ends the sentence; the range ends right there.
    const r = run('It was late. Then.', 'en', [['It was late', 'Era tarde.', 'x'], ['Then', '. Poi', 'r']]);
    expect(pairs(r)).toEqual([['It was late', 'Era tarde'], ['Then', '. Poi']]);
  });
});

describe('determiner left before the range', () => {
  const enIt = { s: 'en', t: 'it' } as const;
  const esEn = { s: 'es', t: 'en' } as const;
  const esIt = { s: 'es', t: 'it' } as const;

  // [label, text, langs, item, expected [source, translation] or null for unchanged]
  it.each([
    // en → it
    ['en-it the + il', 'She sat on the sofa and slept.', enIt, ['sofa', 'il divano', 'n'], ['the sofa', 'il divano']],
    ['en-it a + una', 'She bought a house in May.', enIt, ['house', 'una casa', 'n'], ['a house', 'una casa']],
    ['en-it an + un', 'He ate an apple.', enIt, ['apple', 'una mela', 'n'], ['an apple', 'una mela']],
    ['en-it the + l\'', 'She drank the water.', enIt, ['water', "l'acqua", 'n'], ['the water', "l'acqua"]],
    ['en-it the + gli', 'He saw the friends.', enIt, ['friends', 'gli amici', 'n'], ['the friends', 'gli amici']],
    ['en-it my + il mio', 'I love my house.', enIt, ['house', 'la mia casa', 'n'], ['my house', 'la mia casa']],
    ['en-it my + mia (family noun)', 'I called my mother.', enIt, ['mother', 'mia madre', 'n'], ['my mother', 'mia madre']],
    ['en-it these + questi', 'He sold these books.', enIt, ['books', 'questi libri', 'n'], ['these books', 'questi libri']],
    ['en-it of the + la (of stays English)', 'The door of the house was open.', enIt, ['house', 'la casa', 'n'], ['the house', 'la casa']],
    ['en-it sentence-initial The', 'The sofa was red.', enIt, ['sofa', 'il divano', 'n'], ['The sofa', 'Il divano']],
    ['en-it sentence-initial The + l\'', 'The water was cold.', enIt, ['water', "l'acqua", 'n'], ['The water', "L'acqua"]],
    // es → en
    ['es-en el + the', 'Se sentó en el sofá y durmió.', esEn, ['sofá', 'the sofa', 'n'], ['el sofá', 'the sofa']],
    ['es-en una + a', 'Compró una casa grande.', esEn, ['casa grande', 'a big house', 'n'], ['una casa grande', 'a big house']],
    ['es-en un (article or numeral) + a', 'Vivió allí un año.', esEn, ['año', 'a year', 'n'], ['un año', 'a year']],
    ['es-en su + her', 'Vendió su casa.', esEn, ['casa', 'her house', 'n'], ['su casa', 'her house']],
    ['es-en del + of the', 'Vive en el centro del pueblo.', esEn, ['pueblo', 'of the town', 'n'], ['del pueblo', 'of the town']],
    ['es-en al + to the', 'Fue al mercado ayer.', esEn, ['mercado', 'to the market', 'n'], ['al mercado', 'to the market']],
    ['es-en esos + those (pos n)', 'Compró esos libros.', esEn, ['libros', 'those books', 'n'], ['esos libros', 'those books']],
    // es → it
    ['es-it la + la', 'Pintó la casa de azul.', esIt, ['casa', 'la casa', 'n'], ['la casa', 'la casa']],
    ['es-it un + una', 'Tiene un perro y una casa.', esIt, ['casa', 'una casa', 'n'], ['una casa', 'una casa']],
    ['es-it las + le', 'Lavó las tazas.', esIt, ['tazas', 'le tazze', 'n'], ['las tazas', 'le tazze']],
    ['es-it del + del', 'La tapa del libro.', esIt, ['libro', 'del libro', 'n'], ['del libro', 'del libro']],
    ['es-it del + dell\'', 'El color del agua.', esIt, ['agua', "dell'acqua", 'n'], ['del agua', "dell'acqua"]],
    ['es-it al + al', 'Fue al mercado ayer.', esIt, ['mercado', 'al mercato', 'n'], ['al mercado', 'al mercato']],
    ['es-it unos + dei', 'Compró unos libros.', esIt, ['libros', 'dei libri', 'n'], ['unos libros', 'dei libri']],
    ['es-it El at sentence start', 'El perro duerme.', esIt, ['perro duerme', 'il cane dorme', 'v'], ['El perro duerme', 'Il cane dorme']],
  ])('extends: %s', (_label, text, langs, item, expected) => {
    const r = run(text, langs.s, [item], langs);
    expect(pairs(r)).toEqual([expected]);
    expect(r.kept[0].start).toBe(text.indexOf(expected[0]));
    expect(r.stats.repaired.determiner).toBe(1);
  });

  it.each([
    // look-alikes
    ['en "that" is a conjunction', 'He said that the house was old.', enIt, ['the house was old', 'la casa era vecchia', 'x']],
    ['en "her" object pronoun', 'I gave her the book.', enIt, ['the book', 'il libro', 'n']],
    ['en "her" before a noun is not on the list either', 'I saw her house.', enIt, ['house', 'la sua casa', 'n']],
    ['en "the" not doubled', 'She sat on the sofa.', enIt, ['sofa', 'divano', 'n']],
    ['en "a" as a letter', 'Plan A worked.', enIt, ['worked', 'ha funzionato', 'v']],
    ['en "a" letter mid-sentence, capital', 'He got an A in maths.', enIt, ['maths', 'la matematica', 'n']],
    ['en "this" as a pronoun', 'He said this the day before.', enIt, ['the day before', 'il giorno prima', 'x']],
    ['en "this" standing alone, no pos', 'He bought this one week ago.', enIt, ['week ago', 'una settimana fa', undefined]],
    ['en his as pronoun (pos r)', 'It was his last year.', enIt, ['last year', "l'anno scorso", 'r']],
    ['en name: The Times', 'We visited The Times office.', enIt, ['Times office', "l'ufficio del Times", 'n']],
    ['en range starts with its own determiner', 'He took this the right way.', enIt, ['the right way', 'il modo giusto', 'n']],
    ['en translation starts with a digit', 'He saw the two dogs.', enIt, ['two dogs', '2 cani', 'n']],
    ['en translation "a" is a preposition only in Italian', 'He went the way home.', enIt, ['way home', 'a casa', 'n']],
    ['es "la" clitic before a verb', 'Juan la vio ayer.', esIt, ['vio ayer', "l'ha vista ieri", 'v']],
    ['es "la" clitic, pronoun pos', 'Juan la llamó.', esEn, ['llamó', 'the called', 'p']],
    ['es "lo" is not a determiner', 'Lo bueno es eso.', esEn, ['bueno es eso', 'the good thing is that', 'x']],
    ['es demonstrative pronoun, pos x', 'Compró esos la semana pasada.', esIt, ['la semana pasada', 'la settimana scorsa', 'x']],
    ['es "un" not doubled', 'Vivió allí un año.', esEn, ['año', 'year', 'n']],
    ['es "un" before "one" (not caught)', 'Vivió allí un año.', esEn, ['año', 'one year', 'n']],
    ['es name: La Paz', 'Vive en La Paz desde mayo.', esIt, ['Paz desde mayo', 'La Paz da maggio', 'x']],
    ['es determiner in another sentence', 'Compró el. Libro nuevo.', esIt, ['Libro nuevo', 'Il libro nuovo', 'n']],
    ['es determiner separated by a comma', 'Vio el, pues, perro.', esIt, ['pues, perro', 'il cane', 'n']],
  ])('no change: %s', (_label, text, langs, item) => {
    const r = run(text, langs.s, [item], langs);
    expect(pairs(r)).toEqual([[item[0], item[1]]]);
    expect(r.stats.repaired.determiner).toBe(0);
  });

  it('drops del/al before a bare article: extending would lose the preposition', () => {
    const r = run('La tapa del libro.', 'es', [['libro', 'il libro', 'n']], esIt);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped).toEqual({ determiner: 1 });
    expect(run('El centro del pueblo.', 'es', [['pueblo', 'the town', 'n']], esEn).stats.dropped).toEqual({ determiner: 1 });
  });

  it('drops when the determiner is already inside a kept item', () => {
    const r = run('She sat on the sofa and slept.', 'en', [['on the', 'sul', 's'], ['sofa', 'il divano', 'n']], enIt);
    expect(pairs(r)).toEqual([['on the', 'sul']]);
    expect(r.stats.dropped).toEqual({ determiner: 1 });
    const s = run('Se sentó en el sofá.', 'es', [['Se sentó en el', 'Sat on the', 'v'], ['sofá', 'the sofa', 'n']], esEn);
    expect(s.stats.dropped).toEqual({ determiner: 1 });
  });

  it('occupies the extended range, so a later item cannot take the determiner', () => {
    const r = run('She sat on the sofa and slept.', 'en', [['sofa', 'il divano', 'n'], ['on the', 'sul', 's']], enIt);
    expect(pairs(r)).toEqual([['the sofa', 'il divano']]);
    expect(r.stats.dropped).toEqual({ overlap: 1 });
  });

  it('re-runs name protection on the extended range', () => {
    // "Su" mid-sentence capital is left alone (name-like), so nothing extends.
    const a = run('Vio a Su Majestad.', 'es', [['Majestad', 'la Maestà', 'n']], esIt);
    expect(a.stats.repaired.determiner).toBe(0);
    // A name inside the range must still survive; the determiner does not change that.
    const b = run('Vio a la María de ayer.', 'es', [['María de ayer', 'la ragazza di ieri', 'n']], esIt);
    expect(b.stats.dropped).toEqual({ protected: 1 });
    const c = run('Vio a la María de ayer.', 'es', [['María de ayer', 'la María di ieri', 'n']], esIt);
    expect(pairs(c)).toEqual([['la María de ayer', 'la María di ieri']]);
  });

  it('combines with the punctuation repair', () => {
    const r = run('Dijo: «el perro», y se fue.', 'es', [['perro', 'il cane»', 'n']], esIt);
    expect(pairs(r)).toEqual([['el perro', 'il cane']]);
    expect(r.stats.repaired).toEqual({ punct: 1, determiner: 1 });
  });

  it('is inert without sourceLang/targetLang', () => {
    const r = run('She sat on the sofa and slept.', 'en', [['sofa', 'il divano', 'n']]);
    expect(pairs(r)).toEqual([['sofa', 'il divano']]);
    expect(r.stats.repaired).toEqual({ punct: 0, determiner: 0 });
    const { tokens, masked } = tokenizeWords('a sofa', 'en');
    expect(validateItems([['sofa', 'il divano', 'n']], { text: 'a sofa', tokens, masked, sourceLang: 'en' }).stats.repaired.determiner).toBe(0);
  });
});

describe('determiner review fixes (drops and no-ops instead of a wrong repair)', () => {
  const enIt = { s: 'en', t: 'it' } as const;
  const esEn = { s: 'es', t: 'en' } as const;
  const esIt = { s: 'es', t: 'it' } as const;

  // A different kind of determiner: extending would silently swap the meaning.
  it.each([
    ['es-en su → the (loses the possessive)', 'Vendió su casa.', esEn, ['casa', 'the house', 'n']],
    ['es-it su → la (loses the possessive)', 'Vendió su casa.', esIt, ['casa', 'la casa', 'n']],
    ['es-en este → the (loses the demonstrative)', 'Compré este libro.', esEn, ['libro', 'the book', 'n']],
    ['en-it the → un (definite → indefinite)', 'She saw the dog.', enIt, ['dog', 'un cane', 'n']],
    ['en-it a → la (indefinite → definite)', 'He drank a beer.', enIt, ['beer', 'la birra', 'n']],
    ['en-it my → la madre (loses the possessive)', 'I called my mother.', enIt, ['mother', 'la madre', 'n']],
    ['en-it the → i suoi (adds a possessive)', 'He saw the friends.', enIt, ['friends', 'i suoi amici', 'n']],
    ['es-it el → quello (article → demonstrative)', 'El que llega tarde pierde.', esIt, ['que llega tarde', 'quello che arriva tardi', 'x']],
  ])('drops: %s', (_label, text, langs, item) => {
    const r = run(text, langs.s, [item], langs);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped).toEqual({ determiner: 1 });
  });

  it.each([
    ['es-en su → his', 'Vendió su casa.', esEn, ['casa', 'his house', 'n'], ['su casa', 'his house']],
    ['es-en su → their', 'Vendieron su casa.', esEn, ['casa', 'their house', 'n'], ['su casa', 'their house']],
    ['es-it su → la sua (article + possessive)', 'Vendió su casa.', esIt, ['casa', 'la sua casa', 'n'], ['su casa', 'la sua casa']],
    ['es-it su → la loro', 'Vendieron su casa.', esIt, ['casa', 'la loro casa', 'n'], ['su casa', 'la loro casa']],
    ['en-it its → la sua', 'The dog wagged its tail.', enIt, ['tail', 'la sua coda', 'n'], ['its tail', 'la sua coda']],
    ['es-it unas → alcuni', 'Compró unas flores.', esIt, ['flores', 'alcuni fiori', 'n'], ['unas flores', 'alcuni fiori']],
    ['es-it del → dal (de = from)', 'Salió del cine.', esIt, ['cine', 'dal cinema', 'n'], ['del cine', 'dal cinema']],
    ['es-en del → about the', 'Habló del viaje.', esEn, ['viaje', 'about the trip', 'n'], ['del viaje', 'about the trip']],
  ])('extends: %s', (_label, text, langs, item, expected) => {
    const r = run(text, langs.s, [item], langs);
    expect(pairs(r)).toEqual([expected]);
    expect(r.stats.repaired.determiner).toBe(1);
  });

  it.each([
    ['en all the', 'All the children ran.', enIt, ['children', 'i bambini', 'n']],
    ['en both the', 'He saw both the cars.', enIt, ['cars', 'le macchine', 'n']],
    ['en half the', 'He ate half the cake.', enIt, ['cake', 'la torta', 'n']],
    ['en what a', 'What a day!', enIt, ['day', 'una giornata', 'n']],
    ['en such a', 'It was such a day.', enIt, ['day', 'una giornata', 'n']],
    ['es todos los → the', 'Vinieron todos los niños.', esEn, ['niños', 'the children', 'n']],
    ['es todos los → i', 'Todos los niños corrieron.', esIt, ['niños', 'i bambini', 'n']],
  ])('drops after a predeterminer it would strand: %s', (_label, text, langs, item) => {
    const r = run(text, langs.s, [item], langs);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped).toEqual({ determiner: 1 });
  });

  it.each([
    ['it clitic lo (pos v)', 'He knew the answer.', enIt, ['answer', 'lo sapeva', 'v']],
    ['it clitic la (pos v)', 'He had a look.', enIt, ['look', 'la guardò', 'v']],
    ['it clitic le (pos x)', 'He gave the girl a book.', enIt, ['girl a book', 'le diede un libro', 'x']],
    ['it clitic gli (pos v)', 'He told the kids.', enIt, ['kids', 'gli ha detto', 'v']],
    ['es-en del → of her (del is definite; no possessive added)', 'La casa del padre.', esEn, ['padre', 'of her father', 'n']],
    ['en her is also a pronoun: kind mismatch is a no-op', 'Vio la casa.', esEn, ['casa', 'her house', 'n']],
    ['sentence-initial El + capitalised name', 'El Salvador es pequeño.', esIt, ['Salvador es pequeño', 'il Salvador è piccolo', 'x']],
    ['line break between determiner and range', 'He sat on the\nsofa and slept.', enIt, ['sofa', 'il divano', 'n']],
  ])('no change: %s', (_label, text, langs, item) => {
    const r = run(text, langs.s, [item], langs);
    expect(pairs(r)).toEqual([[item[0], item[1]]]);
    expect(r.stats.repaired.determiner).toBe(0);
  });

  it('line break: also without a sentence list', () => {
    const text = 'He sat on the\nsofa.';
    const { tokens, masked } = tokenizeWords(text, 'en');
    const r = validateItems([['sofa', 'il divano', 'n']], { text, tokens, masked, sourceLang: 'en', targetLang: 'it' });
    expect(r.kept.map(k => k.source)).toEqual(['sofa']);
  });
});

describe('spike replies: zero seam repairs', () => {
  const DIR = fileURLToPath(new URL('./__fixtures__/spike/', import.meta.url));
  const files = readdirSync(DIR).filter(f => f.endsWith('.txt')).sort();
  it.each(files)('%s', f => {
    const p = PASSAGES.find(x => x.id === f.split('.')[0])!;
    const parsed = parseItems(readFileSync(DIR + f, 'utf8'))!;
    const { tokens, masked } = tokenizeWords(p.text, p.source);
    // Both splitters: the chunker's (what B3 will pass) and raw Intl (what spike.test.ts uses).
    const intl: TextRange[] = [...new Intl.Segmenter(p.source, { granularity: 'sentence' }).segment(p.text)]
      .map(x => ({ start: x.index, end: x.index + x.segment.length }));
    for (const sentences of [splitSentences(p.text, p.source), intl]) {
      const r = validateItems(parsed.items, {
        text: p.text, tokens, masked, sentences,
        sourceLang: p.source as SourceLang, targetLang: p.target as TargetLang,
      });
      expect(r.stats.repaired).toEqual({ punct: 0, determiner: 0 });
      expect(r.stats.dropped).toEqual({});
    }
  });
  it('covers all 12', () => expect(files).toHaveLength(12));
});
