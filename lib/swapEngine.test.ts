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
  return {
    translations: selectSpans(text, LEVEL).map((s, i) => ({ i: i + 1, t: `IT(${s.text})` })),
  };
}

function requestBody(call: number) {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

function requestHeaders(call: number) {
  return fetchMock.mock.calls[call][1]?.headers as Record<string, string>;
}

const fetchMock = vi.fn<typeof fetch>();

describe('swap', () => {
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

  it('sends Gemma 4 with an enforced JSON schema to OpenRouter by default', async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(translationsFor(TEXT))));
    await swap(TEXT, LEVEL);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = requestBody(0);
    expect(body.model).toBe('google/gemma-4-26b-a4b-it');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.max_tokens).toBeLessThan(8192);
    expect(requestHeaders(0).Authorization).toBe('Bearer test-key');
  });

  it('works against a key-less local server with config only', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1/');
    vi.stubEnv('LLM_MODEL', 'gemma4:26b');
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(translationsFor(TEXT))));
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    const headers = requestHeaders(0);
    expect(headers.Authorization).toBeUndefined();
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(requestBody(0).model).toBe('gemma4:26b');
    expect(requestBody(0).provider).toBeUndefined();
  });

  it('omits response_format when structured outputs are turned off', async () => {
    vi.stubEnv('LLM_STRUCTURED_OUTPUTS', 'false');
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(translationsFor(TEXT))));
    await swap(TEXT, LEVEL);
    expect(requestBody(0).response_format).toBeUndefined();
  });

  it('keeps the full text in the retry prompt', async () => {
    fetchMock.mockImplementation(async () => completion('{"translations":[]}'));
    await swap(TEXT, LEVEL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(1).messages[1].content).toContain(`Full text: ${TEXT}`);
  });

  it('marks the result degraded when no API key is configured', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const result = await swap(TEXT, LEVEL);
    expect(result.segments).toEqual([{ text: TEXT, lang: 'source', translation: null }]);
    expect(result.degraded).toBe(true);
    expect(result.debug?.[0].message).toContain('LLM_API_KEY is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once on a wrong count, then degrades', async () => {
    fetchMock.mockImplementation(async () => completion('{"translations":[{"i":1,"t":"solo uno"}]}'));
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

  it('reports upstream errors in debug events, with model and response body', async () => {
    vi.stubEnv('OPENROUTER_MODEL', 'retired/model');
    const notFound = () =>
      new Response('{"error":{"message":"retired/model is no longer available"}}', { status: 404 });
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound());
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(true);
    const errors = result.debug!.filter((e) => e.level === 'error');
    expect(errors[0].message).toContain('LLM error 404 from retired/model');
    expect(errors[0].detail).toContain('no longer available');
    expect(errors.at(-1)!.message).toContain('returning original text');
    expect(result.debug![0].message).toContain('retired/model via openrouter.ai');
  });

  it('never puts the API key in debug events', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 401 })).mockResolvedValueOnce(
      new Response('bad', { status: 401 }),
    );
    const result = await swap(TEXT, LEVEL);
    expect(JSON.stringify(result.debug)).not.toContain('test-key');
  });

  it('reports a reply it could not parse', async () => {
    fetchMock.mockResolvedValue(completion('not json at all'));
    const result = await swap(TEXT, LEVEL);
    expect(result.debug!.some((e) => e.message.includes("couldn't use the model's reply"))).toBe(true);
  });
});
