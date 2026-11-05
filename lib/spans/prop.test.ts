// Property test (adapted from the adversarial review of PR #8): random texts,
// random chunks and randomly damaged substring items must never produce an
// invalid span, and undamaged items in order must all align.
import { describe, expect, it } from 'vitest';
import { tokenizeWords, type TextRange } from './tokenize';
import { validateItems } from './validate';

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const VOCAB = [
  'el', 'perro', 'de', 'la', 'casa', 'Dámelo', 'O’Brien', 'well-known', 'dogs’', '10:30', '3,5', '2º', '¿Qué', '¡Vamos',
  '«hola»', 'x.com', 'https://a.es/p?q=1', 'ana@b.es', '👍🏽', '—', '…', 'EE.', 'UU.', 'fin.es', '‘yes’',
  'café'.normalize('NFD'), 'B2B', 'mp3', '\r\n', '\t', '"quoted"', '(paren)', 'de', 'de', 'la', 'example.com/a',
  'fin.Es', 'etc.es', '[12]', "'los", "gatos'", 'él', 'está', 'Esta', 'don’t', 'a b', 'Ph.D',
];

describe('span invariants (property)', () => {
  it('holds over 3000 random texts', () => {
    const v = { roundtrip: 0, overlap: 0, cutsToken: 0, sourceMismatch: 0, numericEnd: 0, maskedInside: 0, sentence: 0, outOfRange: 0, cleanMiss: 0 };
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
      const sentences: TextRange[] = [];
      let st = 0;
      for (const m of text.matchAll(/\. /g)) {
        sentences.push({ start: st, end: (m.index ?? 0) + 2 });
        st = (m.index ?? 0) + 2;
      }
      sentences.push({ start: st, end: text.length });
      const sentenceAt = (o: number) => sentences.findIndex(x => o >= x.start && o < x.end);
      const range = { start: sentences[Math.floor(rnd() * sentences.length)].start, end: text.length };
      const ch = tokens.filter(t => t.start >= range.start);
      if (!ch.length) continue;

      // Clean items: disjoint in-sentence, non-numeric-ended token runs, in order. All must align.
      const clean: unknown[] = [];
      for (let k = 0; k < ch.length; k += 1 + Math.floor(rnd() * 3)) {
        const e = Math.min(ch.length - 1, k + Math.floor(rnd() * 2));
        if (sentenceAt(ch[k].start) !== sentenceAt(ch[e].end - 1)) continue;
        if (masked.some(m => m.start < ch[e].end && m.end > ch[k].start)) continue;
        clean.push([text.slice(ch[k].start, ch[e].end), 'tr' + k, 'n']);
        k = e;
      }
      const cleanRes = validateItems(clean, { text, tokens: ch, masked, sentences, range });
      const missed = (cleanRes.stats.dropped.align ?? 0) + (cleanRes.stats.dropped.boundary ?? 0) + (cleanRes.stats.dropped.overlap ?? 0);
      if (missed) {
        v.cleanMiss += missed;
        examples.cleanMiss ??= JSON.stringify([text, clean, cleanRes.stats.dropped]);
      }

      // Damaged items: wrong case, fragments, hallucinations, cross-sentence, shuffled.
      const items: unknown[] = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) {
        const s = Math.floor(rnd() * ch.length);
        const e = Math.min(ch.length - 1, s + Math.floor(rnd() * 4));
        const phrase = text.slice(ch[s].start, ch[e].end);
        const p = rnd();
        let it: unknown[] = [phrase, 'tr' + k, 'n'];
        if (p < 0.15) it = [phrase.toUpperCase(), 'tr', 'v'];
        else if (p < 0.3) it = [phrase.slice(1), 'tr', 'n'];
        else if (p < 0.4) it = [phrase.slice(0, -1), 'tr', 'n'];
        else if (p < 0.45) it = ['zzz ' + phrase, 'tr', 'n'];
        else if (p < 0.5) it = [phrase, 'tr\nx', 'n'];
        else if (p < 0.55) it = [phrase, 'n'];
        else if (p < 0.6) it = [text.slice(range.start, Math.min(text.length, range.start + 30)), 'tr', ['x']];
        items.push(it);
      }
      const { kept } = validateItems(items, { text, tokens: ch, masked, sentences, range });
      total += kept.length;
      for (const k of [...kept, ...cleanRes.kept]) {
        if (k.start < range.start || k.end > range.end) v.outOfRange++;
        if (text.slice(k.start, k.end) !== k.source) v.sourceMismatch++;
        if (tokens.some(t => (t.start < k.start && k.start < t.end) || (t.start < k.end && k.end < t.end))) {
          v.cutsToken++;
          examples.cutsToken ??= JSON.stringify([text, k.source]);
        }
        const inside = tokens.filter(t => t.start >= k.start && t.end <= k.end);
        if (inside[0].numeric || inside[inside.length - 1].numeric) v.numericEnd++;
        if (masked.some(m => m.start < k.end && m.end > k.start)) v.maskedInside++;
        if (sentenceAt(k.start) !== sentenceAt(k.end - 1)) v.sentence++;
      }
      // overlap within one validate call
      for (const list of [kept, cleanRes.kept]) {
        for (let j = 1; j < list.length; j++) if (list[j].start < list[j - 1].end) v.overlap++;
      }
    }
    expect({ v, examples }).toEqual({
      v: { roundtrip: 0, overlap: 0, cutsToken: 0, sourceMismatch: 0, numericEnd: 0, maskedInside: 0, sentence: 0, outOfRange: 0, cleanMiss: 0 },
      examples: {},
    });
    expect(total).toBeGreaterThan(1000);
  });
});
