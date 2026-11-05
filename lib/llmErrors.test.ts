import { describe, expect, it } from 'vitest';
import { classifyLlmError, parseRetryAfter } from './llmErrors';

const limit = (source: string) => JSON.stringify({ error: { code: 402, message: 'limit', metadata: { limit_source: source } } });

describe('classifyLlmError', () => {
  it.each(['openrouter_key_limit', 'openrouter_workspace_budget', 'openrouter_guardrail_budget', 'openrouter_credits'])(
    'never retries spend limit %s',
    (source) => {
      expect(classifyLlmError(402, limit(source), null)).toEqual({ kind: 'spend_limit', retryable: false, limitSource: source });
      expect(classifyLlmError(403, limit(source), null).retryable).toBe(false);
    },
  );

  it('retries an in-flight budget after Retry-After', () => {
    expect(classifyLlmError(402, limit('openrouter_in_flight_budget'), '2')).toEqual({
      kind: 'in_flight_budget',
      retryable: true,
      retryAfterMs: 2000,
      limitSource: 'openrouter_in_flight_budget',
    });
  });

  it('treats any other 402/403 as a spend limit (e.g. 403 "Key limit exceeded" without limit_source)', () => {
    expect(classifyLlmError(403, '{"error":{"code":403,"message":"Key limit exceeded"}}', null)).toEqual({
      kind: 'spend_limit',
      retryable: false,
    });
    expect(classifyLlmError(402, '<html>', null).retryable).toBe(false);
  });

  it('does not retry a 429', () => {
    expect(classifyLlmError(429, '{}', '20')).toEqual({ kind: 'rate_limited', retryable: false, retryAfterMs: 20_000 });
  });

  it('retries other errors, as before', () => {
    for (const status of [400, 401, 404, 500, 502, 503]) {
      expect(classifyLlmError(status, '<html>', null)).toEqual({ kind: 'other', retryable: true });
    }
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const ms = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())!;
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});
