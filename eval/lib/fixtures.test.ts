import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  FIXTURES_DIR,
  OPEN,
  countWords,
  firstSentence,
  firstWords,
  loadFixtures,
  stripMarkers,
} from './fixtures';

describe('stripMarkers', () => {
  it('returns exact offsets in the stripped text', () => {
    const { text, protected: p } = stripMarkers('Hi ⟦Ana⟧, it is ⟦10:30⟧ now.');
    expect(text).toBe('Hi Ana, it is 10:30 now.');
    expect(p).toEqual([
      { start: 3, end: 6, text: 'Ana' },
      { start: 14, end: 19, text: '10:30' },
    ]);
  });

  it('counts offsets in UTF-16 units, like String.slice', () => {
    const { text, protected: p } = stripMarkers('🐶 ⟦Café⟧');
    expect(text.slice(p[0].start, p[0].end)).toBe('Café');
  });

  it.each([
    ['unclosed', 'a ⟦b'],
    ['unmatched close', 'a ⟧ b'],
    ['nested', '⟦a ⟦b⟧⟧'],
    ['empty', 'a ⟦⟧ b'],
  ])('rejects %s markers', (_, raw) => {
    expect(() => stripMarkers(raw)).toThrow();
  });
});

describe('firstSentence', () => {
  it.each([
    ['I met Tom. He left.', 'I met Tom.'],
    ['We visited the US. It was big.', 'We visited the US.'],
    ['Mr. Dale arrived. Then he sat.', 'Mr. Dale arrived.'],
    ['El Sr. Núñez llegó. Luego se fue.', 'El Sr. Núñez llegó.'],
    ['Viene de EE. UU. con su primo. Luego cena.', 'Viene de EE. UU. con su primo.'],
    ['Yo sí. Luego ya veremos.', 'Yo sí.'],
    ['¿Venís? Yo sí.', '¿Venís?'],
    ['"Come early," she said. Then she left.', '"Come early," she said.'],
    ['Subject: Office move\n\nHi everyone,', 'Subject: Office move'],
    ['No ending at all', 'No ending at all'],
  ])('%j → %j', (input, expected) => {
    expect(firstSentence(input)).toBe(expected);
  });
});

describe('firstWords', () => {
  it('returns a slice ending at the fifth word', () => {
    expect(firstWords('¡Hola, Lucía! Solo quería darte las gracias.', 5, 'es')).toBe(
      'Hola, Lucía! Solo quería darte',
    );
  });
  it('returns the whole text when it is shorter', () => {
    expect(firstWords('Two words', 5, 'en')).toBe('Two words');
  });
});

describe('fixture lint', () => {
  const fixtures = loadFixtures();

  it('has 20 fixtures, 10 per language, with unique ids and files', () => {
    expect(fixtures).toHaveLength(20);
    expect(fixtures.filter((f) => f.lang === 'en')).toHaveLength(10);
    expect(fixtures.filter((f) => f.lang === 'es')).toHaveLength(10);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(20);
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.txt')).sort();
    expect(fixtures.map((f) => f.file).sort()).toEqual(files);
  });

  it.each(['en', 'es'])('%s covers every genre, one torture and one latency fixture', (lang) => {
    const set = fixtures.filter((f) => f.lang === lang);
    expect(new Set(set.map((f) => f.genre))).toEqual(new Set(['news', 'email', 'social', 'recipe']));
    expect(set.filter((f) => f.torture)).toHaveLength(1);
    const latency = set.filter((f) => f.latency);
    expect(latency).toHaveLength(1);
    expect(latency[0].wordCount).toBeGreaterThanOrEqual(950);
  });

  describe.each(fixtures.map((f) => [f.id, f] as const))('%s', (_, f) => {
    it('has no markers left and one range per marker', () => {
      expect(f.text).not.toContain(OPEN);
      expect(f.text).not.toContain(CLOSE);
      expect(f.protected.length).toBe(f.raw.split(OPEN).length - 1);
      expect(f.protected.length).toBeGreaterThan(0);
    });

    it('has exact, ordered, trimmed protected offsets matching the marked tokens', () => {
      const marked = [...f.raw.matchAll(/⟦([^⟧]*)⟧/g)].map((m) => m[1]);
      expect(f.protected.map((p) => p.text)).toEqual(marked);
      let prevEnd = 0;
      for (const p of f.protected) {
        expect(f.text.slice(p.start, p.end)).toBe(p.text);
        expect(p.start).toBeGreaterThanOrEqual(prevEnd);
        expect(p.text.trim()).toBe(p.text);
        prevEnd = p.end;
      }
    });

    it('is within ±15% of its target word count', () => {
      expect(f.wordCount).toBeGreaterThanOrEqual(Math.floor(f.words * 0.85));
      expect(f.wordCount).toBeLessThanOrEqual(Math.ceil(f.words * 1.15));
      expect(countWords(f.text, f.lang)).toBe(f.wordCount);
    });

    it('has metadata and detection variants', () => {
      expect(f.nativeChecked).toBe(false);
      expect(f.firstSentence.length).toBeGreaterThan(0);
      expect(f.text).toContain(f.firstSentence);
      expect(f.text.startsWith(f.first5Words) || f.text.includes(f.first5Words)).toBe(true);
      expect(countWords(f.first5Words, f.lang)).toBe(5);
    });
  });

  it('keeps the NFD text in the Spanish torture fixture', () => {
    const t = fixtures.find((f) => f.id === 'es-torture')!;
    expect(t.text).toContain('cafetería'.normalize('NFD'));
    expect(t.text).toContain(' ');
  });
});
