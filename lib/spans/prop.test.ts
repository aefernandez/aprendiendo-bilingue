// Property test (ported from the adversarial review of PR #8): random texts,
// random chunks and randomly damaged items must never produce an invalid span.
import { describe, expect, it } from 'vitest';
import { tokenizeWords } from './tokenize';
import { validateItems } from './validate';
import { chunkTokens, numberedInput } from './numbered';
import { parseItems } from './parse';

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const VOCAB = [
  'el', 'perro', 'de', 'la', 'casa', 'Dámelo', 'O’Brien', 'well-known', 'dogs’', '10:30', '3,5', '2º', '¿Qué', '¡Vamos',
  '«hola»', 'x.com', 'https://a.es/p?q=1', 'ana@b.es', '👍🏽', '—', '…', 'EE.', 'UU.', 'fin.es', '‘yes’',
  'café'.normalize('NFD'), 'B2B', 'mp3', '\r\n', '\t', '"quoted"', '(paren)', 'de', 'de', 'la', 'example.com/a',
  'fin.Es', 'etc.es', '[12]', "'los", "gatos'",
];

describe('span invariants (property)', () => {
  it('holds over 3000 random texts', () => {
    const v = { roundtrip: 0, numberedLoss: 0, overlap: 0, bounds: 0, wholeTok: 0, numericEnd: 0, maskedInside: 0, sentence: 0 };
    const examples: Record<string, string> = {};
    let total = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const n = 3 + Math.floor(rnd() * 25);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) parts.push(pick(VOCAB) + (rnd() < 0.15 ? '. ' : ' '));
      const text = parts.join('');
      const { tokens, masked } = tokenizeWords(text, pick(['es', 'en']));
      tokens.forEach((t, k) => {
        if (text.slice(t.start, t.end) !== t.text || t.i !== k) v.roundtrip++;
      });
      const strip = (s: string) => s.replace(/\[\d+\]/g, '').replace(/［/g, '[').replace(/］/g, ']');
      if (strip(numberedInput(text, tokens)) !== text) v.numberedLoss++;

      const sentences: { start: number; end: number }[] = [];
      let st = 0;
      for (const m of text.matchAll(/\. /g)) {
        sentences.push({ start: st, end: (m.index ?? 0) + 2 });
        st = (m.index ?? 0) + 2;
      }
      sentences.push({ start: st, end: text.length });
      if (!tokens.length) continue;

      const ch = chunkTokens(tokens, { start: Math.floor((rnd() * text.length) / 2), end: text.length });
      if (!ch.length) continue;
      const items: unknown[] = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) {
        const s = Math.floor(rnd() * ch.length);
        const e = Math.min(ch.length - 1, s + Math.floor(rnd() * 3));
        const base: unknown[] = [s, e, ch[s].text, ch[e].text, 'tr' + k, 'n'];
        const p = rnd();
        let it = [...base];
        if (p < 0.2) {
          const d = pick([-2, -1, 1, 2]);
          it[0] = s + d;
          it[1] = e + d;
        } else if (p < 0.3) it[1] = e + 1;
        else if (p < 0.35) it = [s, e, ch[s].text.toUpperCase(), ch[e].text, 'tr', 'zz'];
        else if (p < 0.4) it = [s, s, ch[s].text, 'tr', 'n'];
        else if (p < 0.45) it = [-5, 1e9, 'x', 'y', 'tr', 'n'];
        else if (p < 0.5) it = [s, e, ch[s].text, ch[e].text, 'tr\nx', 'n'];
        else if (p < 0.55) it = [s, e, ch[s].text, 'tr', 'n'];
        items.push(it);
      }
      const { kept } = validateItems(items, { text, tokens: ch, masked, sentences });
      total += kept.length;
      const sentenceAt = (o: number) => sentences.findIndex(x => o >= x.start && o < x.end);
      let last = -1;
      for (const k of [...kept].sort((x, y) => x.start - y.start)) {
        if (k.start < last) v.overlap++;
        last = k.end;
        if (k.startWord < 0 || k.endWord >= ch.length) {
          v.bounds++;
          continue;
        }
        if (k.start !== ch[k.startWord].start || k.end !== ch[k.endWord].end || k.source !== text.slice(k.start, k.end)) v.wholeTok++;
        if (ch[k.startWord].numeric || ch[k.endWord].numeric) v.numericEnd++;
        if (masked.some(m => m.start < k.end && m.end > k.start)) {
          v.maskedInside++;
          examples.masked ??= JSON.stringify([text, k.source]);
        }
        if (sentenceAt(k.start) !== sentenceAt(k.end - 1)) {
          v.sentence++;
          examples.sentence ??= JSON.stringify([text, k.source]);
        }
      }
    }
    expect({ v, examples }).toEqual({
      v: { roundtrip: 0, numberedLoss: 0, overlap: 0, bounds: 0, wholeTok: 0, numericEnd: 0, maskedInside: 0, sentence: 0 },
      examples: {},
    });
    expect(total).toBeGreaterThan(1000);
  });

  it('parser never throws on truncated or odd input', () => {
    const good = JSON.stringify({ i: [[0, 0, 'a]', 'b"\\', 'n'], [1, 2, 'c', 'd', 'e', 'v']] });
    for (let k = 0; k <= good.length; k++) {
      const r = parseItems(good.slice(0, k));
      if (r) expect(Array.isArray(r.items)).toBe(true);
    }
    for (const bad of ['{"i":5}', '{"i":"x"}', 'null', '5', '{"i":[1,2,3]}', '[[[[[[', '"]"']) {
      expect(() => parseItems(bad)).not.toThrow();
    }
  });
});
