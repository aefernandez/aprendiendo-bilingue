import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS, parseSwapRequest } from './validation';

describe('parseSwapRequest', () => {
  it('accepts a valid request and trims the text', () => {
    expect(parseSwapRequest({ text: '  hello world  ', level: 2 })).toEqual({
      ok: true,
      value: { text: 'hello world', level: 2 },
    });
  });

  it.each([null, 'text', 42, ['x'], undefined])('rejects a non-object body: %j', body => {
    expect(parseSwapRequest(body).ok).toBe(false);
  });

  it.each([123, {}, ['x'], '', '   ', undefined])('rejects bad text: %j', text => {
    expect(parseSwapRequest({ text, level: 1 }).ok).toBe(false);
  });

  it.each([0, 4, -1, 1.5, '1', '3', [3], {}, true, '__proto__', undefined])('rejects bad level: %j', level => {
    expect(parseSwapRequest({ text: 'hello', level }).ok).toBe(false);
  });

  it('rejects text over the length cap', () => {
    const result = parseSwapRequest({ text: 'a'.repeat(MAX_TEXT_CHARS + 1), level: 1 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('too long') });
  });

  it('accepts text exactly at the length cap', () => {
    expect(parseSwapRequest({ text: 'a'.repeat(MAX_TEXT_CHARS), level: 1 }).ok).toBe(true);
  });
});
