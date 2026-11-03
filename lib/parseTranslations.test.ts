import { describe, expect, it } from 'vitest';
import { maxTokensFor, parseTranslations } from './swapEngine';

const ok = (items: Array<[number, string]>) =>
  JSON.stringify({ translations: items.map(([i, t]) => ({ i, t })) });

describe('parseTranslations', () => {
  it('reads the structured shape', () => {
    expect(parseTranslations(ok([[1, 'Lei disse'], [2, 'corri veloce']]), 2)).toEqual(['Lei disse', 'corri veloce']);
  });

  it('places items by index, not by position', () => {
    expect(parseTranslations(ok([[2, 'due'], [1, 'uno']]), 2)).toEqual(['uno', 'due']);
  });

  it('accepts a bare array of strings from backends without structured outputs', () => {
    expect(parseTranslations('["uno","due"]', 2)).toEqual(['uno', 'due']);
  });

  it.each([
    ['wrong count', ok([[1, 'uno']]), 2],
    ['duplicate index', ok([[1, 'uno'], [1, 'due']]), 2],
    ['index out of range', ok([[1, 'uno'], [3, 'tre']]), 2],
    ['empty translation', ok([[1, 'uno'], [2, '  ']]), 2],
    ['non-string translation', '{"translations":[{"i":1,"t":5}]}', 1],
    ['nested arrays', '[["uno"],["due"]]', 2],
    ['unclosed thinking block', '<think>Let me see [1] ... ', 1],
    ['no JSON at all', 'Sorry, I cannot help with that.', 1],
  ])('rejects %s', (_label, content, count) => {
    expect(parseTranslations(content as string, count as number)).toBeNull();
  });

  it('strips a leaked list number', () => {
    expect(parseTranslations(ok([[1, '1. Lei disse'], [2, '2) corri']]), 2)).toEqual(['Lei disse', 'corri']);
  });

  it('tolerates fences, thinking blocks and surrounding prose', () => {
    const body = ok([[1, 'uno']]);
    expect(parseTranslations('```json\n' + body + '\n```', 1)).toEqual(['uno']);
    expect(parseTranslations('<think>[1] maybe {x}</think>' + body, 1)).toEqual(['uno']);
    expect(parseTranslations('Here you go: ' + body + '\nNote: phrase [1] is a verb.', 1)).toEqual(['uno']);
  });
});

describe('maxTokensFor', () => {
  const span = (text: string) => ({ start: 0, end: text.length, text });

  it('has a sensible floor and ceiling', () => {
    expect(maxTokensFor([span('ciao')])).toBe(512);
    expect(maxTokensFor(Array.from({ length: 2_000 }, () => span('a long phrase of words')))).toBe(8192);
  });
});
