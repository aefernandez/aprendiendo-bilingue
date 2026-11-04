import type { Level, SwapRequest } from './types';

// ~2,000 English words: comfortably above a typical news article (the spec's
// v1 upper bound) while keeping tagger time, prompt size and cost bounded.
export const MAX_TEXT_CHARS = 12_000;

const LEVELS: readonly Level[] = [1, 2, 3];

export type ValidationResult =
  | { ok: true; value: SwapRequest }
  | { ok: false; error: string };

export function parseSwapRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const { text, level } = body as Record<string, unknown>;

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'Missing text.' };
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      error: `Text is too long (${trimmed.length.toLocaleString('en-US')} characters). The limit is ${MAX_TEXT_CHARS.toLocaleString('en-US')}.`,
    };
  }

  if (typeof level !== 'number' || !LEVELS.includes(level as Level)) {
    return { ok: false, error: 'Level must be 1, 2 or 3.' };
  }

  return { ok: true, value: { text: trimmed, level: level as Level } };
}
