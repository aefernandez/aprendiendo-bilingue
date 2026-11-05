import { describe, expect, it } from 'vitest';
import { isNumeric, tokenizeWords } from './tokenize';

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
  });

  it('returns nothing for empty or punctuation-only text', () => {
    expect(tokenizeWords('', 'en').tokens).toEqual([]);
    expect(tokenizeWords(' ¿?! … ', 'es').tokens).toEqual([]);
  });
});

describe('review fixes', () => {
  it('keeps closing quotes outside the word, also across sentences', () => {
    expect(words('She said ‘yes’ and left.')).toEqual(['She', 'said', 'yes', 'and', 'left']);
    expect(words("Dijo 'los gatos' ayer.", 'es')).toEqual(['Dijo', 'los', 'gatos', 'ayer']);
    expect(words('‘Stop. Look at the bosses’ he said.')).toEqual(['Stop', 'Look', 'at', 'the', 'bosses', 'he', 'said']);
    expect(words("'Run! The dogs' he yelled.")).toEqual(['Run', 'The', 'dogs', 'he', 'yelled']);
    expect(words("the dogs' toys. 'Hi' to the cats' owner")).toEqual(['the', "dogs'", 'toys', 'Hi', 'to', 'the', "cats'", 'owner']);
    // A new paragraph resets quote state.
    expect(words("'Hi\nthe dogs' toys")).toEqual(['Hi', 'the', "dogs'", 'toys']);
  });

  it('tokenizes possessive-heavy text in linear time', () => {
    for (const unit of ["the dogs' ", "'a dogs' "]) {
      const text = unit.repeat(Math.ceil(12000 / unit.length)).slice(0, 12000);
      const t0 = performance.now();
      tokenizeWords(text, 'en');
      expect(performance.now() - t0).toBeLessThan(150);
    }
  });

  it('splits glued sentences only for TLD-like endings', () => {
    expect(words('Llegó al fin.Es tarde.', 'es')).toEqual(['Llegó', 'al', 'fin', 'Es', 'tarde']);
    expect(words('I like Italia.It was great')).toEqual(['I', 'like', 'Italia', 'It', 'was', 'great']);
    expect(words('Ver etc.es', 'es')).toEqual(['Ver', 'etc', 'es']);
    expect(words('a Ph.D student', 'en')).toEqual(['a', 'Ph.D', 'student']);
    expect(words('en el 200 a.C. y Node.Js', 'es')).toEqual(['en', 'el', '200', 'a.C', 'y', 'Node.Js']);
    expect(tokenizeWords('Mira elpais.es y x.com hoy', 'es').masked.map(m => m.kind)).toEqual(['domain', 'domain']);
  });

  it('masks bare domains with a path, ftp, and balanced parentheses', () => {
    const t = 'Visit example.com/path?q=1 now. ftp://x.org/f (https://es.wikipedia.org/wiki/Foo_(bar)) next';
    expect(words(t)).toEqual(['Visit', 'now', 'next']);
    expect(tokenizeWords(t, 'en').masked.map(m => t.slice(m.start, m.end))).toEqual([
      'example.com/path?q=1', 'ftp://x.org/f', 'https://es.wikipedia.org/wiki/Foo_(bar)',
    ]);
    // Known false positive (harmless: masked text is never swapped).
    expect(words('dos kg.es/mes', 'es')).toEqual(['dos']);
  });
});
