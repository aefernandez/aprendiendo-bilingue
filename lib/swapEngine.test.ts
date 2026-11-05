import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maxTokensFor, swap } from './swapEngine';
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
    // Slow providers are deprioritised (not excluded) so calls finish inside the deadline.
    expect(body.provider).toEqual({ require_parameters: true, preferred_min_throughput: { p90: 40 } });
    expect(body.reasoning).toEqual({ enabled: false });
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
    expect(requestBody(0).reasoning).toBeUndefined();
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
    ['a body without choices', () => new Response('null', { status: 200 })],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('degrades instead of throwing on %s, and still retries', async (_label, makeResponse) => {
    fetchMock.mockImplementation(async () => makeResponse());
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Retrying a 429 within the same few seconds only adds load: degrade after one call.
  it('degrades instead of throwing on a 429, without retrying', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"error":"rate limited"}', { status: 429, headers: { 'Retry-After': '20' } }),
    );
    const result = await swap(TEXT, LEVEL);
    expect(result.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.debug!.some((e) => e.message.includes('rate limited (429, Retry-After 20 s), not retrying'))).toBe(true);
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

// ---------------------------------------------------------------------------
// Chunked translation
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_TARGET_TOKENS, MAX_CHUNKS, phraseTokens, planChunks } from './swapEngine';
import { splitSentences } from './chunker';
import type { Span } from './types';

// Packing is by whole sentence, so a chunk can exceed the target by at most
// one sentence's weight.
function chunkBound(text: string, spans: Span[]): number {
  const total = spans.reduce((n, s) => n + phraseTokens(s), 0);
  const heaviest = Math.max(
    ...splitSentences(text, 'en').map((r) =>
      spans.filter((s) => s.start >= r.start && s.start < r.end).reduce((n, s) => n + phraseTokens(s), 0),
    ),
  );
  return Math.max(CHUNK_TARGET_TOKENS, Math.ceil(total / MAX_CHUNKS)) + heaviest;
}

// Request bodies captured from swap() on main @ d14dd59 (before chunking), with
// a mocked fetch. Keys: `${text}-L${level}`.
const PRE_CHUNKING_BODIES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'pre-chunking-request-bodies.json'), 'utf8'),
) as Record<string, Record<string, unknown>[]>;
const GOLDEN_TEXTS: Record<string, string> = {
  short: 'The dog runs home. The cat sleeps all day.',
  medium:
    'My grandmother lived in a small house near the river. Every morning she walked to the market and bought fresh bread.\n\nShe told me stories about her childhood, about the war and the long winters.',
};

const PARAGRAPH =
  'The old fisherman walked slowly along the quiet harbour while the morning light painted the water. ' +
  'He remembered the storms of his youth and the friends who sailed beside him through the cold winters. ' +
  'Children played near the boats, laughing loudly as their mothers carried baskets of bread to the market. ' +
  'Every evening the village gathered in the square to share news, sing songs and watch the sun disappear. ';

function longText(chars: number): string {
  let text = '';
  for (let i = 0; text.length < chars; i++) text += PARAGRAPH + (i % 3 === 2 ? '\n\n' : '');
  return text.slice(0, chars);
}

// Answers each call with IT(phrase) for exactly the phrases it was sent.
function phrasesIn(body: { messages: { content: string }[] }): string[] {
  const user = body.messages[1].content;
  const list = user.split('Translate each phrase to Italian:\n')[1].split('\n\nReturn {')[0];
  return list.split('\n').map((line) => line.replace(/^\d+\. /, ''));
}

function echoTranslations(init: RequestInit | undefined) {
  const phrases = phrasesIn(JSON.parse(String(init?.body)));
  return completion(JSON.stringify({ translations: phrases.map((p, i) => ({ i: i + 1, t: `IT(${p})` })) }));
}

describe('swap (chunked)', () => {
  beforeEach(() => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  // A single-chunk text sends the same body as before chunking, byte for byte,
  // except two OpenRouter routing fields added by this change.
  it.each(Object.keys(PRE_CHUNKING_BODIES))('sends the pre-chunking request body for %s', async (key) => {
    const [name, levelTag] = key.split('-L');
    fetchMock.mockImplementation(async (_url, init) => echoTranslations(init));
    await swap(GOLDEN_TEXTS[name], Number(levelTag) as 1 | 2 | 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [before] = PRE_CHUNKING_BODIES[key];
    const expected = {
      ...before,
      provider: { ...(before.provider as object), preferred_min_throughput: { p90: 40 } },
      reasoning: { enabled: false },
    };
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe(JSON.stringify(expected));
  });

  it('splits a long text into parallel calls that each send the full text and only their own phrases', async () => {
    const text = longText(10_000);
    const spans = selectSpans(text, 1);
    fetchMock.mockImplementation(async (_url, init) => echoTranslations(init));
    const result = await swap(text, 1);

    const calls = fetchMock.mock.calls.length;
    const bound = chunkBound(text, spans);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(result.degraded).toBe(false);
    expect(result.partial).toBeUndefined();

    const sent: string[] = [];
    for (let i = 0; i < calls; i++) {
      const body = requestBody(i);
      expect(body.messages[1].content.startsWith(`Full text: ${text}\n\nTranslate each phrase`)).toBe(true);
      const phrases = phrasesIn(body);
      sent.push(...phrases);
      const est = phrases.reduce((n, p) => n + phraseTokens({ start: 0, end: p.length, text: p }), 0);
      expect(est).toBeLessThanOrEqual(bound);
      expect(body.max_tokens).toBe(maxTokensFor(phrases.map((p) => ({ start: 0, end: p.length, text: p }))));
    }
    // Every phrase sent exactly once, in order.
    expect(sent).toEqual(spans.map((s) => s.text));
    // Segments rebuild the text with each phrase swapped.
    expect(result.segments.map((s) => (s.lang === 'target' ? s.translation : s.text)).join('')).toBe(text);
    expect(result.debug!.some((e) => /^Chunk \d+\/\d+: \d+ phrases in [\d,]+ ms$/.test(e.message))).toBe(true);
  });

  it('keeps a chunk that fails twice as source and marks the result partial', async () => {
    const text = longText(6_000);
    const groups = planChunks(text, selectSpans(text, 1));
    expect(groups.length).toBeGreaterThan(2);
    // First attempts start in chunk order, so call 1 is chunk 2; its retry is the
    // only call using the retry prompt.
    let call = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      const isRetry = String(init?.body).includes('Your previous answer was not valid');
      if (call++ === 1 || isRetry) return new Response('upstream', { status: 502 });
      return echoTranslations(init);
    });
    const result = await swap(text, 1);
    expect(result.degraded).toBe(false);
    expect(result.partial).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(groups.length + 1); // one retry of the failing chunk
    const translated = result.segments.filter((s) => s.lang === 'target').map((s) => s.translation);
    expect(translated).toEqual(groups.filter((_, i) => i !== 1).flat().map((s) => s.text));
    expect(result.segments.map((s) => (s.lang === 'target' ? s.translation : s.text)).join('')).toBe(text);
    expect(result.debug!.some((e) => e.message.startsWith(`Partial result: 1 of ${groups.length} chunks`))).toBe(true);
  });

  it('degrades when every chunk fails', async () => {
    const text = longText(6_000);
    fetchMock.mockImplementation(async () => new Response('upstream', { status: 502 }));
    const result = await swap(text, 1);
    expect(result.degraded).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(result.segments).toEqual([{ text, lang: 'source', translation: null }]);
    expect(result.debug!.at(-1)!.message).toBe('No usable translations — returning original text');
  });

  it('returns by the deadline when every chunk hangs', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await swap(longText(10_000), 1, { deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.degraded).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps a text at the 12,000-char cap within MAX_CHUNKS and the token target', () => {
    for (const level of [1, 2, 3] as const) {
      const text = longText(12_000);
      const spans = selectSpans(text, level);
      const groups = planChunks(text, spans);
      expect(groups.length).toBeLessThanOrEqual(MAX_CHUNKS);
      expect(groups.flat()).toEqual(spans);
      const bound = chunkBound(text, spans);
      for (const g of groups) expect(g.reduce((n, s) => n + phraseTokens(s), 0)).toBeLessThanOrEqual(bound);
    }
  });
});
