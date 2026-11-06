// Repros and measurements from the adversarial review of PR #8, round 3.
import { describe, expect, it } from 'vitest';
import { tokenizeWords, type TextRange } from './tokenize';
import { validateItems } from './validate';

function sents(text: string): TextRange[] {
  const out: TextRange[] = [];
  for (const s of new Intl.Segmenter('es', { granularity: 'sentence' }).segment(text)) out.push({ start: s.index, end: s.index + s.segment.length });
  return out;
}
/** Renders the swap so a wrong occurrence is visible in the assertion. */
function render(text: string, items: unknown[], loc = 'es'): string {
  const { tokens, masked } = tokenizeWords(text, loc);
  const { kept } = validateItems(items, { text, tokens, masked, sentences: sents(text) });
  let out = '';
  let at = 0;
  for (const k of kept) {
    out += text.slice(at, k.start) + (k.cognate ? k.source : `[${k.translation}]`);
    at = k.end;
  }
  return out + text.slice(at);
}

describe('A1: out-of-order items never take the wrong occurrence', () => {
  it('Dijo que sí / más alto que', () => {
    expect(render('Dijo que sí. Es más alto que yo.', [['sí', 'yes', 'i'], ['que', 'that', 'c'], ['más alto', 'taller', 'a'], ['que', 'than', 'c']]))
      .toBe('Dijo que [yes]. Es [taller] [than] yo.'); // 'que' fits both sentences: dropped as ambiguous
  });

  it('Como pan / como él', () => {
    expect(render('Como pan. Hablo como él.', [['pan', 'bread', 'n'], ['Como', 'I eat', 'v'], ['como', 'like', 's']]))
      .toBe('Como [bread]. Hablo como él.'); // Como/como: dropped, never cross-swapped
    expect(render('Como pan todos los días. Hablo como él.', [['pan', 'bread', 'n'], ['como', 'I eat', 'v'], ['Hablo', 'I speak', 'v'], ['como', 'like', 's']]))
      .toBe('Como [bread] todos los días. [I speak] [like] él.');
  });

  it('La llama / llama a su madre', () => {
    expect(render('La llama come. Ella llama a su madre.', [['come', 'eats', 'v'], ['llama', 'llama', 'n'], ['Ella', 'She', 'p'], ['llama', 'calls', 'v']]))
      .toBe('La llama [eats]. [She] [calls] a su madre.');
  });

  it('Vino tarde / vino tinto (model lowercased)', () => {
    expect(render('Vino tarde. Bebió vino tinto.', [['tarde', 'late', 'r'], ['vino', 'Came', 'v'], ['vino tinto', 'red wine', 'n']]))
      .toBe('Vino [late]. Bebió [red wine].');
  });

  it('drops instead of guessing: unknown position, duplicate item', () => {
    // "arroz" is unique in the chunk, so it may be found ahead; the repeated "come" may not.
    expect(render('Él come pan. Ella come fruta. Yo como arroz.', [['arroz', 'rice', 'n'], ['come', 'eats', 'v'], ['pan', 'bread', 'n']]))
      .toBe('Él come pan. Ella come fruta. Yo como [rice].');
    expect(render('El banco está cerrado. Me senté en el banco del parque.',
      [['El banco', 'The bank', 'n'], ['cerrado', 'closed', 'a'], ['Me senté', 'I sat', 'v'], ['el banco', 'the bench', 'n'], ['el banco', 'the bank', 'n']]))
      .toBe('[The bank] está [closed]. [I sat] en [the bench] del parque.');
  });

  it('keeps the wrong-occurrence rate low when replies are partly shuffled', () => {
    let seed = 777;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const VOCAB = ['que', 'de', 'la', 'el', 'come', 'como', 'vino', 'casa', 'perro', 'y', 'en', 'un', 'pan', 'Juan', 'María', 'muy'];
    const rate = (swapP: number) => {
      let kept = 0;
      let wrong = 0;
      const byHow: Record<string, number> = {};
      let harmful = 0;
      for (let iter = 0; iter < 1000; iter++) {
        let text = '';
        const sentences: TextRange[] = [];
        for (let s = 0, ns = 2 + Math.floor(rnd() * 4); s < ns; s++) {
          const st = text.length;
          const w: string[] = [];
          for (let k = 0, n = 4 + Math.floor(rnd() * 8); k < n; k++) w.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
          text += w.join(' ') + '. ';
          sentences.push({ start: st, end: text.length });
        }
        const { tokens, masked } = tokenizeWords(text, 'es');
        const items: { it: unknown[]; at: number }[] = [];
        for (let k = 0; k < tokens.length; k += 1 + Math.floor(rnd() * 2)) items.push({ it: [tokens[k].text, 'T' + k, 'n'], at: tokens[k].start });
        for (let k = 0; k + 1 < items.length; k++) {
          if (rnd() < swapP) {
            [items[k], items[k + 1]] = [items[k + 1], items[k]];
            k++;
          }
        }
        const r = validateItems(items.map(x => x.it), { text, tokens, masked, sentences });
        void byHow;
        kept += r.kept.length;
        for (const k of r.kept) {
          const want = items.find(x => x.it[1] === k.translation)!.at;
          if (want === k.start) continue;
          wrong++;
          byHow[k.how] = (byHow[k.how] ?? 0) + 1;
          // Harmful: a different sentence (identical neighbour words in one sentence render the same).
          if (sentences.findIndex(x => want >= x.start && want < x.end) !== sentences.findIndex(x => k.start >= x.start && k.start < x.end)) harmful++;
        }
      }
      return { w: wrong / kept, h: harmful / kept, kept, byHow };
    };
    const r0 = rate(0);
    const r10 = rate(0.1);
    const r20 = rate(0.2);
    // Round 3 measured 3.2% / 19.6% / 30.7% wrong occurrences for 0 / 10 / 20%
    // adjacent swaps. The in-order baseline (identical neighbours after a
    // skipped item) is inherent; "h" counts the harmful cross-sentence ones.
    // Measured here: 3.3% / 7.2% / 10.2% (cross-sentence: 0.6% / 1.9% / 3.1%).
    // The remaining same-sentence cases are a later repeat of the same word.
    expect(r0.w).toBeLessThan(0.04);
    expect(r10.w).toBeLessThan(0.08);
    expect(r20.w).toBeLessThan(0.115);
    expect(r0.h).toBeLessThan(0.01);
    expect(r10.h).toBeLessThan(0.025);
    expect(r20.h).toBeLessThan(0.04);
  });
});

describe('M1/M2: protected names — both directions', () => {
  const keptOf = (text: string, items: unknown[], loc = 'es') => render(text, items, loc);

  it('protects a sentence-initial name that also appears mid-sentence', () => {
    expect(keptOf('María come pan. Luego llega María.', [['María come', 'She eats', 'v']])).toBe('María come pan. Luego llega María.');
    expect(keptOf('María come pan. Luego llega María.', [['María come', 'María mangia', 'v']])).toBe('[María mangia] pan. Luego llega María.');
  });

  it('requires a capitalised translation for a span at an initial capital (weak rule for one-off names)', () => {
    expect(keptOf('«Pedro come pan», dijo.', [['Pedro come pan', 'eats bread', 'v']])).toBe('«Pedro come pan», dijo.');
    // Known limit: a one-off sentence-initial name replaced by a capitalised pronoun passes.
    expect(keptOf('«Pedro come pan», dijo.', [['Pedro come pan', 'He eats bread', 'v']])).toBe('«[He eats bread]», dijo.');
  });

  it('keeps ordinary capitalised words: I-contractions, languages, holidays, family titles, Usted', () => {
    expect(keptOf('I speak English and Spanish.', [['speak English', 'parlo inglese', 'v'], ['Spanish', 'spagnolo', 'n']], 'en'))
      .toBe('I [parlo inglese] and [spagnolo].');
    expect(keptOf("I'm tired and I've eaten.", [["I'm tired", 'sono stanco', 'a'], ["I've eaten", 'ho mangiato', 'v']], 'en'))
      .toBe('[sono stanco] and [ho mangiato].');
    expect(keptOf('We celebrate Christmas with Mom.', [['celebrate Christmas', 'festeggiamo il Natale', 'v'], ['with Mom', 'con la mamma', 's']], 'en'))
      .toBe('We [festeggiamo il Natale] [con la mamma].');
    expect(keptOf('Dijo que Usted tiene razón.', [['Usted tiene razón', 'you are right', 'v']])).toBe('Dijo que [you are right].');
  });

  it('accepts exonyms but not a lost name', () => {
    expect(keptOf('Yo vivo en España.', [['vivo en España', 'vivo in Spagna', 'v']])).toBe('Yo [vivo in Spagna].');
    expect(keptOf('Yo vivo con Carmen.', [['vivo con Carmen', 'vivo con lei', 'v']])).toBe('Yo vivo con Carmen.');
    expect(keptOf('Ayer Carmen Ruiz abrió.', [['Ayer Carmen Ruiz abrió', 'Yesterday Carmen opened', 'v']])).toBe('Ayer Carmen Ruiz abrió.');
  });

  it('L3: matches names on word boundaries and numbers by full digits', () => {
    expect(keptOf('Yo vi a Ana ayer.', [['vi a Ana', 'ho vista la banana', 'v']])).toBe('Yo vi a Ana ayer.');
    // Known limit of the exonym allowance: any extra capitalised word stands in for a lost name.
    expect(keptOf('Yo vi a Ana ayer.', [['vi a Ana', 'ho visto Anaconda', 'v']])).toBe('Yo [ho visto Anaconda] ayer.');
    expect(keptOf('Pesa 3,5 kilos.', [['Pesa 3,5 kilos', 'It weighs 35 kilos', 'v']])).toBe('Pesa 3,5 kilos.');
    expect(keptOf('Pesa 3,5 kilos.', [['Pesa 3,5 kilos', 'It weighs 3.5 kilos', 'v']])).toBe('[It weighs 3.5 kilos].');
    expect(keptOf('Hay 1.000 peras.', [['Hay 1.000 peras', 'There are 1000 pears', 'v']])).toBe('[There are 1000 pears].');
  });
});

describe('Lows', () => {
  it('L4: a phrase may stop before a possessive apostrophe', () => {
    expect(render("I fed the dogs' bowls.", [['the dogs', 'i cani', 'n']], 'en')).toBe("I fed [i cani]' bowls.");
  });
});
