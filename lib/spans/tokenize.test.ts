import { describe, expect, it } from 'vitest';
import { isNumeric, tokenizeWords } from './tokenize';
import { chunkTokens, numberedInput } from './numbered';

const words = (t: string, loc = 'en') => tokenizeWords(t, loc).tokens.map(x => x.text);
const expectRoundTrip = (t: string, loc: string) => {
  const { tokens } = tokenizeWords(t, loc);
  tokens.forEach((tok, k) => {
    expect(t.slice(tok.start, tok.end)).toBe(tok.text);
    expect(tok.i).toBe(k);
  });
};

describe('tokenizeWords', () => {
  it('keeps apostrophe words whole, joins plural possessives', () => {
    expect(words("I don't know O’Brien or rock’n’roll")).toEqual(['I', "don't", 'know', 'O’Brien', 'or', 'rock’n’roll']);
    expect(words("the dogs' toys and the dogs’ bowls")).toEqual(['the', "dogs'", 'toys', 'and', 'the', 'dogs’', 'bowls']);
    expect(words("'Hello' she said")).toEqual(['Hello', 'she', 'said']);
  });

  it('does not treat a closing quote after s as a possessive', () => {
    expect(words("'yes' she said")).toEqual(['yes', 'she', 'said']);
  });

  it('joins letter-hyphen-letter but not numbers or spaced dashes', () => {
    expect(words('a well-known e-mail post-COVID mother-in-law')).toEqual(['a', 'well-known', 'e-mail', 'post-COVID', 'mother-in-law']);
    expect(words('COVID-19 and 2020-2021, a - b, a -b')).toEqual(['COVID', '19', 'and', '2020', '2021', 'a', 'b', 'a', 'b']);
  });

  it('handles Spanish clitics, del/al and ¿¡', () => {
    expect(words('¿Dámelo del pan? ¡Vamos al río!', 'es')).toEqual(['Dámelo', 'del', 'pan', 'Vamos', 'al', 'río']);
  });

  it('keeps offsets on NFC and NFD text', () => {
    const nfc = 'Dámelo, canción';
    const nfd = nfc.normalize('NFD');
    const toks = tokenizeWords(nfd, 'es').tokens;
    expect(toks).toHaveLength(2);
    expect(toks[1].end).toBe(nfd.length);
    expectRoundTrip(nfd, 'es');
    expectRoundTrip(nfc, 'es');
  });

  it('gives no index to curly quotes, guillemets or emoji', () => {
    expect(words('“Hola” 👍🏽 «adiós» 👨‍👩‍👧 fin', 'es')).toEqual(['Hola', 'adiós', 'fin']);
  });

  it('classifies numbers and joins times', () => {
    const t = tokenizeWords('3,5 1.000 10:30h 10:30 2º 3años 30h 1st 4.5km B2B mp3 COVID-19', 'es').tokens;
    expect(t.map(x => [x.text, x.numeric])).toEqual([
      ['3,5', true], ['1.000', true], ['10:30h', true], ['10:30', true], ['2º', true], ['3años', true], ['30h', true],
      ['1st', true], ['4.5km', true], ['B2B', false], ['mp3', false], ['COVID', false], ['19', true],
    ]);
    expect(isNumeric('º')).toBe(false);
    expect(isNumeric('casa')).toBe(false);
  });

  it('masks URLs, emails and bare domains', () => {
    const text = 'See https://ex.com/a-b?q=1&x=y. Mail ana.p@correo.es, or visit www.foo.org/x) and x.com today.';
    const { tokens, masked } = tokenizeWords(text, 'en');
    expect(tokens.map(x => x.text)).toEqual(['See', 'Mail', 'or', 'visit', 'and', 'today']);
    expect(masked.map(m => [text.slice(m.start, m.end), m.kind])).toEqual([
      ['https://ex.com/a-b?q=1&x=y', 'url'], ['ana.p@correo.es', 'email'], ['www.foo.org/x', 'url'], ['x.com', 'domain'],
    ]);
    expectRoundTrip(text, 'en');
    const n = numberedInput(text, tokens);
    expect(n.startsWith('[0]See https://ex.com/a-b?q=1&x=y.')).toBe(true);
  });

  it('returns nothing for empty or punctuation-only text', () => {
    expect(tokenizeWords('', 'en').tokens).toEqual([]);
    expect(tokenizeWords(' ¿?! … ', 'es').tokens).toEqual([]);
  });
});

describe('numberedInput / chunkTokens', () => {
  const text = 'Juan come pan y bebe agua. Luego come fruta.';

  it('numbers the whole text', () => {
    expect(numberedInput(text, tokenizeWords(text, 'es').tokens)).toBe(
      '[0]Juan [1]come [2]pan [3]y [4]bebe [5]agua. [6]Luego [7]come [8]fruta.',
    );
  });

  it('re-indexes a chunk from 0 and keeps absolute offsets', () => {
    const { tokens } = tokenizeWords(text, 'es');
    const range = { start: 27, end: text.length };
    const local = chunkTokens(tokens, range);
    expect(local.map(t => [t.i, t.text])).toEqual([[0, 'Luego'], [1, 'come'], [2, 'fruta']]);
    expect(local[0].start).toBe(27);
    expect(numberedInput(text, local, range)).toBe('[0]Luego [1]come [2]fruta.');
  });

  it('leaves out a token straddling the chunk edge', () => {
    const { tokens } = tokenizeWords(text, 'es');
    expect(chunkTokens(tokens, { start: 2, end: 9 }).map(t => t.text)).toEqual(['come']);
  });
});
