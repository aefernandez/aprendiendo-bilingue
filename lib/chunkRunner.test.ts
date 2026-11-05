import { describe, expect, it, vi } from 'vitest';
import { runChunks, type ChunkOutcome } from './chunkRunner';
import { Diagnostics } from './diagnostics';

type Script = (chunk: number, attempt: number, timeoutMs: number, signal: AbortSignal) => Promise<ChunkOutcome<string>>;

const ok = (value: string): ChunkOutcome<string> => ({ ok: true, value });
const err = (retryable = true, retryAfterMs?: number): ChunkOutcome<string> =>
  retryAfterMs === undefined ? { ok: false, reason: 'boom', retryable } : { ok: false, reason: 'boom', retryable, retryAfterMs };
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function run(n: number, script: Script, opts: { deadlineMs?: number; maxRetries?: number; minRetryMs?: number; hedgeAfterMs?: number } = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const deadline = opts.deadlineMs ?? 10_000;
  const startedAt = Date.now();
  const diag = new Diagnostics();
  const calls: { chunk: number; attempt: number; timeoutMs: number; at: number; signal: AbortSignal; previous?: unknown }[] = [];
  const chunks = Array.from({ length: n }, (_, i) => i);
  const promise = runChunks(
    chunks,
    (chunk, attempt, timeoutMs, signal, previous) => {
      calls.push({ chunk, attempt, timeoutMs, at: Date.now() - startedAt, signal, previous });
      return script(chunk, attempt, timeoutMs, signal);
    },
    {
      remaining: () => deadline - (Date.now() - startedAt),
      hedgeAfterMs: opts.hedgeAfterMs ?? 8_000,
      maxRetries: opts.maxRetries ?? 2,
      minRetryMs: opts.minRetryMs ?? 100,
      diag,
      label: (c) => `Chunk ${c + 1}/${n}`,
    },
  );
  return { promise, calls, diag };
}

describe('runChunks', () => {
  it('starts every chunk before any resolves, and returns results in input order', async () => {
    const { promise, calls } = run(5, (c) => after(50 - c * 10, ok(`v${c}`)));
    expect(calls).toHaveLength(5); // all started synchronously
    const results = await promise;
    expect(results.map((r) => r.value)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
  });

  it('retries a failed chunk once and keeps the success', async () => {
    const { promise, calls } = run(1, async (_c, attempt) => (attempt === 1 ? err() : ok('second')));
    const [result] = await promise;
    expect(result).toMatchObject({ value: 'second', attempts: 2 });
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('retries a fast failure without waiting for a slow chunk', async () => {
    const { promise, calls } = run(3, async (c, attempt) => {
      if (c === 0 && attempt === 1) return err();
      return after(c === 2 ? 300 : 10, ok(`v${c}`));
    });
    const results = await promise;
    const retry = calls.find((c) => c.attempt === 2)!;
    expect(retry.at).toBeLessThan(100);
    expect(results.map((r) => r.value)).toEqual(['v0', 'v1', 'v2']);
  });

  it('caps retries across the request', async () => {
    const { promise, calls, diag } = run(7, async (c, attempt) => (c < 3 || attempt === 2 ? err() : ok('x')), {
      maxRetries: 2,
    });
    await promise;
    expect(calls.filter((c) => c.attempt === 2)).toHaveLength(2);
    expect(diag.events.some((e) => e.message.includes('Retry budget used'))).toBe(true);
  });

  it('does not retry a non-retryable failure', async () => {
    const { promise, calls, diag } = run(1, async () => err(false));
    const [result] = await promise;
    expect(result.value).toBeNull();
    expect(calls).toHaveLength(1);
    expect(diag.events.at(-1)!.message).toBe('Chunk 1/1: boom, not retrying');
  });

  it('does not retry when too little time remains', async () => {
    const { promise, calls } = run(1, () => after(80, err()), { deadlineMs: 150, minRetryMs: 100 });
    await promise;
    expect(calls).toHaveLength(1);
  });

  it('stops retrying once at least 2 and more than half of the chunks failed', async () => {
    const { promise, calls, diag } = run(4, async (c) => (c < 3 ? err() : ok('x')), { maxRetries: 10 });
    await promise;
    // First failure retried (1 of 4), second retried (2 of 4 is not > half), third is not.
    expect(calls.filter((c) => c.attempt === 2)).toHaveLength(2);
    expect(diag.events.some((e) => e.message === '3 of 4 chunks failed, not retrying')).toBe(true);
  });

  it('gives the first request the whole budget and a retry what is left', async () => {
    const { promise, calls } = run(1, async (_c, attempt) => (attempt === 1 ? err() : ok('x')), {
      deadlineMs: 1_000,
      hedgeAfterMs: 300,
    });
    await promise;
    expect(calls[0].timeoutMs).toBeGreaterThan(990);
    expect(calls[1].timeoutMs).toBeGreaterThan(900);
    expect(calls[1].previous).toMatchObject({ ok: false, reason: 'boom' });
  });

  it('hedges a slow request without cancelling it, and keeps the first valid reply', async () => {
    // The original answers at 250 ms; the hedge (sent at 100 ms) would answer at 400 ms.
    const { promise, calls } = run(1, (_c, attempt) => after(attempt === 1 ? 250 : 300, ok(`a${attempt}`)), {
      hedgeAfterMs: 100,
    });
    const [result] = await promise;
    expect(result).toMatchObject({ value: 'a1', attempts: 2, hedged: true });
    expect(calls[1].at).toBeGreaterThanOrEqual(95);
    expect(calls[1].at).toBeLessThan(200);
    expect(calls[1].previous).toBeUndefined();
    expect(calls[0].signal.aborted).toBe(true); // aborted only after it won (cleanup)
    expect(calls[1].signal.aborted).toBe(true); // the loser is cancelled
  });

  it('takes the hedge when it answers first', async () => {
    const { promise } = run(1, (_c, attempt) => after(attempt === 1 ? 500 : 50, ok(`a${attempt}`)), {
      hedgeAfterMs: 100,
    });
    const [result] = await promise;
    expect(result.value).toBe('a2');
    expect(result.ms).toBeLessThan(300);
  });

  it('waits for the slow original when the hedge fails', async () => {
    const { promise } = run(1, (_c, attempt) => (attempt === 1 ? after(300, ok('slow')) : after(10, err())), {
      hedgeAfterMs: 100,
    });
    expect((await promise)[0].value).toBe('slow');
  });

  it('counts hedges against the retry budget', async () => {
    const { promise, calls } = run(4, (c) => after(200, ok(`v${c}`)), { hedgeAfterMs: 50, maxRetries: 2 });
    await promise;
    expect(calls.filter((c) => c.attempt === 2)).toHaveLength(2);
  });

  it('does not hedge when too little time remains', async () => {
    const { promise, calls } = run(1, () => after(200, ok('x')), { hedgeAfterMs: 50, deadlineMs: 200, minRetryMs: 180 });
    await promise;
    expect(calls).toHaveLength(1);
  });

  it('waits Retry-After before retrying, if the budget allows', async () => {
    const { promise, calls } = run(1, async (_c, attempt) => (attempt === 1 ? err(true, 100) : ok('x')), {
      deadlineMs: 2_000,
    });
    const [result] = await promise;
    expect(result.value).toBe('x');
    expect(calls[1].at).toBeGreaterThanOrEqual(95);
  });

  it('skips the retry when Retry-After would run past the budget', async () => {
    const { promise, calls } = run(1, async () => err(true, 5_000), { deadlineMs: 2_000 });
    await promise;
    expect(calls).toHaveLength(1);
  });

  it('treats a throwing call as a failed chunk', async () => {
    const { promise } = run(2, async (c) => {
      if (c === 0) throw new Error('bug');
      return ok('x');
    });
    expect((await promise).map((r) => r.value)).toEqual([null, 'x']);
  });
});
