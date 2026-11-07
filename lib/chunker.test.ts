import { describe, expect, it } from 'vitest';
import { chunkText, splitSentences, type TextRange } from './chunker';

const sentencesOf = (text: string, locale = 'en') =>
  splitSentences(text, locale).map((r) => text.slice(r.start, r.end));

function expectTiles(text: string, ranges: TextRange[]) {
  expect(ranges[0].start).toBe(0);
  expect(ranges[ranges.length - 1].end).toBe(text.length);
  for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
}

describe('splitSentences', () => {
  it.each([
    ['Mr. Smith met Dr. Jones at 5 p.m. today. He left.', ['Mr. Smith met Dr. Jones at 5 p.m. today. ', 'He left.']],
    ['I ran. He sat.', ['I ran. ', 'He sat.']],
    ['I met Tom. He left.', ['I met Tom. ', 'He left.']],
    ['We visited the US. It was big.', ['We visited the US. ', 'It was big.']],
    ['She lives in the U.S. now. Fine.', ['She lives in the U.S. now. ', 'Fine.']],
    ['J. R. R. Tolkien wrote it. Yes.', ['J. R. R. Tolkien wrote it. ', 'Yes.']],
    ['We met in St. Louis. It rained.', ['We met in St. Louis. ', 'It rained.']],
    ['It took approx. three days. Then rest.', ['It took approx. three days. ', 'Then rest.']],
    ['Fruit, e.g. Apples, is good. Eat it.', ['Fruit, e.g. Apples, is good. ', 'Eat it.']],
    ['Mr. Smith met Dr. Jones at 3 p.m. on Jan. 5. Then he left.', ['Mr. Smith met Dr. Jones at 3 p.m. on Jan. 5. ', 'Then he left.']],
    ['Capt. Smith, Gen. Lee and Rev. Hale met. Ok.', ['Capt. Smith, Gen. Lee and Rev. Hale met. ', 'Ok.']],
    ['Mt. Everest is high. Ok.', ['Mt. Everest is high. ', 'Ok.']],
    ['He read vol. Two and ch. Three today. Ok.', ['He read vol. Two and ch. Three today. ', 'Ok.']],
    ['They reached the Mount. Then it rained.', ['They reached the Mount. ', 'Then it rained.']],
    ['Mr. Maxwell came at 9.45 and left. Then he slept.', ['Mr. Maxwell came at 9.45 and left. ', 'Then he slept.']],
  ])('English: %s', (text, expected) => {
    expect(sentencesOf(text)).toEqual(expected);
  });

  // B3's cases: Spanish abbreviations must not split, real short sentences must.
  it.each([
    ['Los EE. UU. son grandes. El Sr. García llegó. Yo sí. Luego fue.', ['Los EE. UU. son grandes. ', 'El Sr. García llegó. ', 'Yo sí. ', 'Luego fue.']],
    ['Vivo en EE. UU. Es grande.', ['Vivo en EE. UU. Es grande.']],
    ['Llegó la Sra. Pérez a las 5 p. m. Luego cenamos.', ['Llegó la Sra. Pérez a las 5 p. m. Luego cenamos.']],
    ['Frutas, p. ej. Manzanas. Bien.', ['Frutas, p. ej. Manzanas. ', 'Bien.']],
    ['El Lic. Pérez y el Ing. Gómez. Luego.', ['El Lic. Pérez y el Ing. Gómez. ', 'Luego.']],
    ['Vive en la Avda. Mayo. Luego.', ['Vive en la Avda. Mayo. ', 'Luego.']],
    ['Ver núm. Siete y pág. Cuatro hoy. Bien.', ['Ver núm. Siete y pág. Cuatro hoy. ', 'Bien.']],
    ['Vio el Ingenio. Luego se fue.', ['Vio el Ingenio. ', 'Luego se fue.']],
    ['Mide 3,5 m y pesa 4.5 kg. Es grande.', ['Mide 3,5 m y pesa 4.5 kg. ', 'Es grande.']],
  ])('Spanish: %s', (text, expected) => {
    expect(sentencesOf(text, 'es')).toEqual(expected);
  });

  it('treats line breaks as hard ends, even after an abbreviation', () => {
    expect(sentencesOf('Ask Dr.\nNo one came.\n\nNew paragraph')).toEqual(['Ask Dr.\n', 'No one came.\n', '\n', 'New paragraph']);
  });

  it('tiles the text', () => {
    const text = '  Leading space. Then "quoted." And more!\n\nEnd';
    expectTiles(text, splitSentences(text, 'en'));
  });
});

describe('chunkText', () => {
  const sentence = (i: number) => `This is sentence number ${String(i).padStart(3, '0')} here. `; // 34 chars

  it('gives one chunk for a text under the target', () => {
    const text = 'One sentence. Two sentences.';
    const chunks = chunkText(text, { locale: 'en', target: 1000, maxChunks: 12 });
    expect(chunks).toEqual([{ index: 0, start: 0, end: text.length, sentences: splitSentences(text, 'en') }]);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('', { locale: 'en', target: 10, maxChunks: 12 })).toEqual([]);
  });

  it('packs whole sentences up to the target and tiles the text', () => {
    const text = Array.from({ length: 20 }, (_, i) => sentence(i)).join('');
    const chunks = chunkText(text, { locale: 'en', target: 100, maxChunks: 12 });
    expectTiles(text, chunks);
    for (const c of chunks) {
      expect(c.end - c.start).toBeLessThanOrEqual(100);
      expectTiles(text.slice(0, c.end), [{ start: 0, end: c.start }, ...c.sentences]);
    }
    // 2 sentences (68 chars) per chunk; a third would make 102.
    expect(chunks).toHaveLength(10);
  });

  it('closes a chunk at a paragraph end once it is 60% full', () => {
    const text = `${sentence(1)}${sentence(2)}\n${sentence(3)}`; // 69 chars, then a paragraph
    const chunks = chunkText(text, { locale: 'en', target: 110, maxChunks: 12 });
    expect(chunks.map((c) => text.slice(c.start, c.end))).toEqual([`${sentence(1)}${sentence(2)}\n`, sentence(3)]);
  });

  it('does not close early at a paragraph end below 60%', () => {
    const text = `${sentence(1)}\n${sentence(2)}`;
    expect(chunkText(text, { locale: 'en', target: 200, maxChunks: 12 })).toHaveLength(1);
  });

  it('never exceeds maxChunks, raising the target instead', () => {
    const text = Array.from({ length: 350 }, (_, i) => sentence(i)).join(''); // ~12K chars
    const chunks = chunkText(text, { locale: 'en', target: 100, maxChunks: 12 });
    expect(chunks.length).toBeLessThanOrEqual(12);
    expectTiles(text, chunks);
  });

  it('hard-splits a long unpunctuated run at word boundaries, never inside protect', () => {
    const words = Array.from({ length: 640 }, (_, i) => `word${i}`);
    const text = words.join(' '); // ~3,800 chars, no sentence ends
    const protect: TextRange[] = [];
    // Protect every two-word pair starting at an even word.
    let pos = 0;
    for (let i = 0; i < words.length; i++) {
      const end = pos + words[i].length;
      if (i % 2 === 0 && i + 1 < words.length) protect.push({ start: pos, end: end + 1 + words[i + 1].length });
      pos = end + 1;
    }
    const chunks = chunkText(text, { locale: 'en', target: 400, maxChunks: 12 });
    expect(chunks.length).toBeGreaterThan(1);
    expectTiles(text, chunks);
    const withProtect = chunkText(text, { locale: 'en', target: 400, maxChunks: 12, protect });
    expectTiles(text, withProtect);
    for (const c of withProtect) {
      expect(text[c.start - 1] ?? ' ').toBe(' '); // starts at a word
      for (const p of protect) expect(c.start > p.start && c.start < p.end).toBe(false);
    }
  });

  it('lets the weight callback drive packing', () => {
    // Weight = number of "X" characters: only the heavy sentences count.
    const text = 'X X X X. Light one. Light two. X X X X. Light three.';
    const weight = (r: TextRange) => (text.slice(r.start, r.end).match(/X/g) ?? []).length;
    const chunks = chunkText(text, { locale: 'en', target: 4, maxChunks: 12, weight });
    expect(chunks.map((c) => text.slice(c.start, c.end))).toEqual([
      'X X X X. Light one. Light two. ',
      'X X X X. Light three.',
    ]);
  });

  it('keeps a protected range that spans a sentence boundary in one chunk', () => {
    const text = 'Aaaa bbbb. Cccc dddd. Eeee ffff.';
    const protect = [{ start: 5, end: 15 }]; // "bbbb. Cccc"
    const chunks = chunkText(text, { locale: 'en', target: 5, maxChunks: 12, protect });
    expectTiles(text, chunks);
    for (const c of chunks) expect(c.start > 5 && c.start < 15).toBe(false);
  });
});
