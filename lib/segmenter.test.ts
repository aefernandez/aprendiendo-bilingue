import { describe, expect, it } from 'vitest';
import { reconstructSegments } from './segmenter';

describe('reconstructSegments', () => {
  it('keeps the whitespace between two translated phrases', () => {
    const text = 'red car';
    const segments = reconstructSegments(
      text,
      [
        { start: 0, end: 3, text: 'red' },
        { start: 4, end: 7, text: 'car' },
      ],
      ['rossa', 'macchina'],
    );
    expect(segments.map(s => s.text).join('')).toBe('rossa macchina');
  });

  it('preserves all untranslated source text around spans', () => {
    const text = 'She said: "run fast."';
    const segments = reconstructSegments(text, [{ start: 0, end: 8, text: 'She said' }], ['Lei disse']);
    expect(segments).toEqual([
      { text: 'Lei disse', lang: 'target', translation: 'She said' },
      { text: ': "run fast."', lang: 'source', translation: null },
    ]);
  });
});
