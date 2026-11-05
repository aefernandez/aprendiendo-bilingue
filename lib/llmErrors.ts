// Classifies a failed LLM HTTP response: should the engine retry it?
//
// - Spend limits (OpenRouter 402/403 with error.metadata.limit_source) never
//   resolve within a request: never retried.
// - openrouter_in_flight_budget clears as other requests finish: retryable
//   after Retry-After.
// - 429 (rate limited): not retried. Retrying inside the same few seconds only
//   adds load, and Retry-After is usually longer than our budget.
// - Everything else (5xx, 404, 401, bad bodies…): retryable, as before.

export type LlmErrorKind = 'spend_limit' | 'in_flight_budget' | 'rate_limited' | 'other';

export interface LlmErrorClass {
  kind: LlmErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  limitSource?: string;
}

const SPEND_LIMIT_SOURCES = new Set([
  'openrouter_key_limit',
  'openrouter_workspace_budget',
  'openrouter_guardrail_budget',
  'openrouter_credits',
]);

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function limitSourceOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { metadata?: { limit_source?: unknown } } };
    const source = parsed?.error?.metadata?.limit_source;
    return typeof source === 'string' ? source : undefined;
  } catch {
    return undefined;
  }
}

export function classifyLlmError(status: number, body: string, retryAfterHeader: string | null): LlmErrorClass {
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  if (status === 402 || status === 403) {
    const limitSource = limitSourceOf(body);
    if (limitSource && SPEND_LIMIT_SOURCES.has(limitSource)) {
      return { kind: 'spend_limit', retryable: false, limitSource };
    }
    if (limitSource === 'openrouter_in_flight_budget') {
      return { kind: 'in_flight_budget', retryable: true, retryAfterMs, limitSource };
    }
  }
  if (status === 429) return { kind: 'rate_limited', retryable: false, retryAfterMs };
  return { kind: 'other', retryable: true };
}
