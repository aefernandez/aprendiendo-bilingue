import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swap } from './swapEngine';
import { selectSpans } from './tagger';

const TEXT = 'The dog runs home. The cat sleeps all day.';
const LEVEL = 1;

function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function translationsFor(text: string) {
  return selectSpans(text, LEVEL).map(s => `IT(${s.text})`);
}

describe('swap', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it('returns mixed segments when the model answers correctly', async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(translationsFor(TEXT))));
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(false);
    expect(result.segments.some(s => s.lang === 'target')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks the result degraded when no API key is configured', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const result = await swap(TEXT, LEVEL);
    expect(result).toEqual({ segments: [{ text: TEXT, lang: 'source', translation: null }], degraded: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once on a wrong count, then degrades', async () => {
    fetchMock.mockImplementation(async () => completion('["only one"]'));
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an HTML 200 page', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ['a 429', () => new Response('{"error":"rate limited"}', { status: 429 })],
    ['a body without choices', () => new Response('null', { status: 200 })],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('degrades instead of throwing on %s, and still retries', async (_label, makeResponse) => {
    fetchMock.mockImplementation(async () => makeResponse());
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline when the model hangs', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await swap(TEXT, LEVEL, { deadlineMs: 300 });
    const elapsed = Date.now() - started;
    expect(result.degraded).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    // No time left for a retry after the first call used the whole budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not log full upstream error bodies', async () => {
    const huge = 'x'.repeat(10_000);
    fetchMock.mockImplementation(async () => new Response(huge, { status: 502 }));
    await swap(TEXT, LEVEL);
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged.length).toBeLessThan(2_000);
  });

  it('is not degraded when there is simply nothing to swap', async () => {
    const result = await swap('John and Mary, 1962.', LEVEL);
    expect(result.degraded).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
