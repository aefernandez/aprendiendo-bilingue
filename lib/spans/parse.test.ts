import { describe, expect, it } from 'vitest';
import { parseItems } from './parse';

describe('parseItems', () => {
  it('parses a clean reply with both tuple lengths', () => {
    const p = parseItems('{"i":[[1,1,"come","mangia","v"],[4,5,"bebe","agua","beve acqua","v"]]}');
    expect(p).toEqual({ items: [[1, 1, 'come', 'mangia', 'v'], [4, 5, 'bebe', 'agua', 'beve acqua', 'v']], truncated: false });
  });

  it('accepts a bare array', () => {
    expect(parseItems('[[0,0,"a","b","n"]]')!.items).toHaveLength(1);
  });

  it('salvages complete items from a cut-off reply, with escaped quote and bracket', () => {
    const cut = '{"i":[[1,2,"come","pan","mangia il pane","v"],[4,5,"bebe","agua","beve \\"ac]qua\\"","v"],[7,8,"co';
    const p = parseItems(cut)!;
    expect([p.items.length, p.truncated]).toEqual([2, true]);
    expect((p.items[1] as string[])[4]).toBe('beve "ac]qua"');
  });

  it('salvages when the outer array closed but trailing junk breaks JSON', () => {
    const p = parseItems('{"i":[[0,0,"a","b","n"]] oops')!;
    expect(p).toEqual({ items: [[0, 0, 'a', 'b', 'n']], truncated: false });
  });

  it('strips code fences and <think>', () => {
    expect(parseItems('```json\n{"i":[]}\n```')!.items).toHaveLength(0);
    expect(parseItems('<think>hmm [1]</think>{"i":[[0,0,"a","b","n"]]}')!.items).toHaveLength(1);
  });

  it('returns null for unclosed <think> and garbage', () => {
    expect(parseItems('<think>still thinking [[1,2')).toBeNull();
    expect(parseItems('sorry, I cannot')).toBeNull();
    expect(parseItems('{"x": 1}')).toBeNull();
  });
});
