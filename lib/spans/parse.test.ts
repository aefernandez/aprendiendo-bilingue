import { describe, expect, it } from 'vitest';
import { parseItems } from './parse';

describe('parseItems (substring format)', () => {
  it('parses a clean reply and a bare array', () => {
    expect(parseItems('{"i":[["come pan","mangia pane","v"]]}')).toEqual({
      items: [['come pan', 'mangia pane', 'v']], truncated: false, method: 'json',
    });
    expect(parseItems('[["a","b","n"]]')!.items).toHaveLength(1);
  });

  it('salvages a cut-off reply, keeping escaped quotes and brackets', () => {
    const p = parseItems('{"i":[["come pan","mangia il pane","v"],["bebe \\"ag]ua\\"","beve","v"],["luego","po');
    expect(p!.truncated).toBe(true);
    expect(p!.items).toEqual([['come pan', 'mangia il pane', 'v'], ['bebe "ag]ua"', 'beve', 'v']]);
  });

  it('salvages per item when pos is an unclosed ["n" (seen in the spike)', () => {
    const p = parseItems('{"i":[["El perro","Il cane",["n"],["come pan","mangia pane","v"],["agua","acqua","n"]]}');
    expect(p!.method).toBe('regex');
    expect(p!.items).toEqual([['El perro', 'Il cane', 'n'], ['come pan', 'mangia pane', 'v'], ['agua', 'acqua', 'n']]);
  });

  it('strips <think> in any case and code fences', () => {
    expect(parseItems('```json\n{"i":[["a","b","n"]]}\n```')!.items).toHaveLength(1);
    expect(parseItems('<Think>hmm ["x","y"]</Think>{"i":[["a","b","n"]]}')!.items).toEqual([['a', 'b', 'n']]);
    expect(parseItems('```JSON\n{"i":[]}\n```')).toEqual({ items: [], truncated: false, method: 'json' });
  });

  it('treats an explicit empty list as success', () => {
    expect(parseItems('<Think>x</Think>{"i":[]}')!.items).toEqual([]);
    expect(parseItems('Answer: {"i": []} extra')!.items).toEqual([]);
    expect(parseItems('I found none: []')!.items).toEqual([]);
  });

  it('ignores prose brackets and returns null for garbage', () => {
    expect(parseItems('Sure [1]: [["a","b","n"]]')!.items).toEqual([['a', 'b', 'n']]);
    expect(parseItems('<think>still thinking [["a","b"')).toBeNull();
    expect(parseItems('sorry, I cannot')).toBeNull();
    expect(parseItems('Sure [1] and [2].')).toBeNull();
  });

  it('never throws on truncated prefixes', () => {
    const good = JSON.stringify({ i: [['a]', 'b"\\', 'n'], ['c d', 'e', ['v']]] });
    for (let k = 0; k <= good.length; k++) {
      const r = parseItems(good.slice(0, k));
      if (r) expect(Array.isArray(r.items)).toBe(true);
    }
    for (const bad of ['{"i":5}', '{"i":"x"}', 'null', '5', '[[[[[[', '"]"']) expect(() => parseItems(bad)).not.toThrow();
  });
});
