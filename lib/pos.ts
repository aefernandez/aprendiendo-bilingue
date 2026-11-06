// Part-of-speech codes the LLM span engine asks the model to return, one per
// swapped item. For a multi-word phrase the code is that of its head word;
// `x` marks a fixed multi-word expression (idiom) with no single head.
export const POS_CODES = ['n', 'v', 'a', 'r', 'p', 'd', 's', 'c', 'i', 'x'] as const;

export type PosCode = (typeof POS_CODES)[number];

// English labels: the UI chrome is English-only.
export const POS_LABELS: Readonly<Record<PosCode, string>> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  r: 'adverb',
  p: 'pronoun',
  d: 'determiner',
  s: 'preposition',
  c: 'conjunction',
  i: 'interjection',
  x: 'expression',
};

export function isPosCode(value: unknown): value is PosCode {
  return typeof value === 'string' && (POS_CODES as readonly string[]).includes(value);
}
