// Repros from the adversarial review of PR #8 (round 1).
import { describe, expect, it } from 'vitest';
import { tokenizeWords } from './tokenize';
import { parseItems } from './parse';
import { validateItems } from './validate';
import { chunkTokens, numberedInput } from './numbered';
import { coverage } from './coverage';

const words = (t: string, loc = 'en') => tokenizeWords(t, loc).tokens.map(x => x.text);
const maskedText = (t: string, loc = 'en') => tokenizeWords(t, loc).masked.map(m => t.slice(m.start, m.end));
function run(text: string, loc: string, items: unknown[]) {
  const { tokens, masked } = tokenizeWords(text, loc);
  return validateItems(items, { text, tokens, masked });
}

describe('H1: spans never swallow a masked range', () => {
  it('drops a span covering a URL or a bare domain', () => {
    let r = run('Visit https://x.com/a today please.', 'en', [[0, 1, 'Visit', 'today', 'Visita oggi', 'v']]);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped.masked).toBe(1);
    r = run('Mira x.com hoy.', 'es', [[0, 1, 'Mira', 'hoy', 'Guarda oggi', 'v']]);
    expect(r.stats.dropped.masked).toBe(1);
    r = run('Escribe a ana@b.es hoy.', 'es', [[1, 2, 'a', 'hoy', 'a oggi', 's']]);
    expect(r.stats.dropped.masked).toBe(1);
  });

  it('keeps a span next to (not over) a URL', () => {
    const r = run('Visit https://x.com/a today please.', 'en', [[1, 2, 'today', 'please', 'oggi per favore', 'r']]);
    expect(r.kept.map(k => k.source)).toEqual(['today please']);
  });
});

describe('H2: closing quotes after s stay outside the word', () => {
  it('handles ‘yes’, quoted phrases and genuine possessives', () => {
    expect(words('She said ‘yes’ and left.')).toEqual(['She', 'said', 'yes', 'and', 'left']);
    expect(words("Dijo 'los gatos' ayer.", 'es')).toEqual(['Dijo', 'los', 'gatos', 'ayer']);
    expect(words('the ‘bosses’ came')).toEqual(['the', 'bosses', 'came']);
    expect(words("the dogs' toys. 'Hi' to the cats' owner")).toEqual(['the', "dogs'", 'toys', 'Hi', 'to', 'the', "cats'", 'owner']);
    const r = run('She said ‘yes’ and left.', 'en', [[2, 2, 'yes', 'sì', 'i']]);
    expect(r.kept[0].source).toBe('yes');
  });
});

describe('M1: missing space after a full stop is not a domain', () => {
  it('splits glued sentences and abbreviations into words', () => {
    expect(words('Llegó al fin.Es tarde.', 'es')).toEqual(['Llegó', 'al', 'fin', 'Es', 'tarde']);
    expect(words('I like Italia.It was great')).toEqual(['I', 'like', 'Italia', 'It', 'was', 'great']);
    expect(words('Ver etc.es', 'es')).toEqual(['Ver', 'etc', 'es']);
    expect(maskedText('Llegó al fin.Es tarde.', 'es')).toEqual([]);
  });

  it('still masks real domains and leaves Node.js alone', () => {
    expect(maskedText('Mira elpais.es y x.com hoy', 'es')).toEqual(['elpais.es', 'x.com']);
    expect(words('Uso Node.js', 'es')).toEqual(['Uso', 'Node.js']);
  });
});

describe('M2/L3: URL masking', () => {
  it('masks a bare domain with a path', () => {
    expect(words('Visit example.com/path?q=1 now')).toEqual(['Visit', 'now']);
    expect(maskedText('Visit example.com/path?q=1 now')).toEqual(['example.com/path?q=1']);
  });

  it('masks ftp:// and keeps a balanced closing parenthesis', () => {
    const t = 'HTTPS://EX.COM/a. ftp://x.org/f (https://es.wikipedia.org/wiki/Foo_(bar)) next';
    expect(words(t)).toEqual(['next']);
    expect(maskedText(t)).toEqual(['HTTPS://EX.COM/a', 'ftp://x.org/f', 'https://es.wikipedia.org/wiki/Foo_(bar)']);
  });
});

describe('M3: parser does not mistake prose brackets for the list', () => {
  it('finds the item array after a stray [1]', () => {
    expect(parseItems('Sure [1]: [[0,0,"a","b","n"]]')).toEqual({ items: [[0, 0, 'a', 'b', 'n']], truncated: false });
  });

  it('returns null when salvage recovers nothing', () => {
    expect(parseItems('Sure [1] and [2].')).toBeNull();
    expect(parseItems('{"i":[1,2,3]} x')).toBeNull();
  });

  it('keeps a well-formed empty list as success', () => {
    expect(parseItems('{"i":[]}')).toEqual({ items: [], truncated: false });
  });
});

describe('M4: end-anchor ties are dropped', () => {
  const text = 'el perro de la casa de mi madre come pan';
  // [0]el [1]perro [2]de [3]la [4]casa [5]de [6]mi [7]madre [8]come [9]pan

  it('drops e+1 when e-2 matches too', () => {
    const r = run(text, 'es', [[0, 4, 'el', 'de', 'x', 'n']]);
    expect(r.kept).toEqual([]);
    expect(r.stats.dropped.endAnchor).toBe(1);
  });

  it('still repairs unambiguous ends', () => {
    expect(run(text, 'es', [[1, 4, 'perro', 'casa', 'cane della casa', 'n']]).kept[0].source).toBe('perro de la casa');
    expect(run(text, 'es', [[2, 5, 'perro', 'casa', 'cane della casa', 'n']]).kept[0].source).toBe('perro de la casa');
    expect(run(text, 'es', [[1, 5, 'perro', 'casa', 'cane della casa', 'n']]).kept[0].source).toBe('perro de la casa');
  });

  it('settles e-1 vs e+1 by the chunk mode', () => {
    // [1,3,'perro','de']: e=3 'la'; 'de' at e-1=2 and e+1=4? no: 4 is casa. Use a text where it is.
    const t = 'un vaso de agua de mar y un plato de sopa y un trozo de pan';
    // [0]un [1]vaso [2]de [3]agua [4]de [5]mar [6]y [7]un [8]plato [9]de [10]sopa [11]y [12]un [13]trozo [14]de [15]pan
    const tie: unknown = [0, 3, 'un', 'de', 'un bicchiere di', 'n']; // 'de' at 2 and 4
    expect(run(t, 'es', [tie]).stats.dropped.endAnchor).toBe(1);
    const r = run(t, 'es', [tie, [7, 11, 'un', 'sopa', 'un piatto di zuppa', 'n'], [12, 16, 'un', 'pan', 'un pezzo di pane', 'n']]);
    expect(r.stats.exclusiveMode).toBe(true);
    expect(r.kept.map(k => k.source)).toEqual(['un vaso de', 'un plato de sopa', 'un trozo de pan']);
  });
});

describe('M5: coverage on merged chunks', () => {
  it('gives the same answer with whole-text or chunk tokens', () => {
    const text = 'uno dos. tres cuatro.';
    const { tokens: all, masked } = tokenizeWords(text, 'es');
    const range = { start: 9, end: text.length };
    const ch = chunkTokens(all, range);
    const kept = validateItems([[0, 0, 'tres', 'tre', 'n']], { text, tokens: ch, masked }).kept;
    expect(coverage(ch, kept)).toBe(0.5);
    expect(coverage(all, kept)).toBe(0.25);
    const first = validateItems([[0, 0, 'uno', 'one', 'n']], { text, tokens: chunkTokens(all, { start: 0, end: 9 }), masked }).kept;
    expect(coverage(all, [...first, ...kept])).toBe(0.5);
  });
});

describe('Lows', () => {
  it('L1: accepts a 4-element single word, a 5-element multi-word without pos, and digit strings', () => {
    const text = 'el perro de la casa';
    let r = run(text, 'es', [[1, 1, 'Perro', 'cane']]);
    expect(r.kept[0]).toMatchObject({ source: 'perro', translation: 'cane', pos: undefined });
    r = run(text, 'es', [[3, 4, 'la', 'casa', 'la casa']]);
    expect(r.kept[0]).toMatchObject({ source: 'la casa', translation: 'la casa', cognate: true });
    r = run(text, 'es', [['1', '1', 'perro', 'cane', 'n']]);
    expect(r.kept[0].source).toBe('perro');
    r = run(text, 'es', [[1.5, 1, 'perro', 'cane', 'n'], [1, 2, 'perro', 'cane di', 'n'], [1, 1, 'perro', 'cane', 'n', 'x', 'y']]);
    expect(r.stats.dropped).toEqual({ shape: 2, endAnchor: 1 });
  });

  it('L2: accent-insensitive anchor only at the given index', () => {
    const text = 'un café y él';
    expect(run(text, 'es', [[1, 1, 'cafe', 'caffè', 'n']]).kept[0].source).toBe('café');
    // 'el' at index 2 is 'y'; 'él' at 3 must not be reached by an accent-blind repair
    expect(run(text, 'es', [[2, 2, 'el', 'lui', 'p']]).stats.dropped.anchor).toBe(1);
  });

  it('L4: literal [n] citations do not look like index markers', () => {
    const text = 'see note [12] here';
    expect(numberedInput(text, tokenizeWords(text, 'en').tokens)).toBe('[0]see [1]note ［[2]12］ [3]here');
  });

  it('L5: rock-\'n\'-roll is three tokens (documented)', () => {
    expect(words("rock-'n'-roll")).toEqual(['rock', 'n', 'roll']);
  });
});
