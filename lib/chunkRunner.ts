// Generic parallel fan-out for chunked model calls, with a shared deadline and
// a small per-request retry budget. Knows nothing about prompts or responses:
// the engine (tagger today, B3's span engine later) supplies `call`.

import type { Diagnostics } from './diagnostics';

export type ChunkOutcome<T> =
  | { ok: true; value: T }
  // retryAfterMs: wait this long before retrying (e.g. an in-flight budget).
  | { ok: false; reason: string; retryable: boolean; retryAfterMs?: number };

export interface ChunkResult<T> {
  value: T | null;
  attempts: number;
  // Time from the start of the run until this chunk settled.
  ms: number;
}

export interface RunOptions<C> {
  // Milliseconds left in the request's budget.
  remaining: () => number;
  // Cap on a first attempt's timeout, so one slow provider can't hold a chunk
  // for the whole budget. A timed-out first attempt may be retried.
  firstAttemptMs: number;
  // Total retries across all chunks in this run.
  maxRetries: number;
  // Don't start a retry with less than this much time left.
  minRetryMs: number;
  diag: Diagnostics;
  // How the chunk is named in diagnostics, e.g. "Chunk 3/10".
  label: (chunk: C) => string;
}

/**
 * Starts every chunk's first attempt at once. A chunk that fails is retried
 * as soon as it fails (not after the others settle) if its failure is
 * retryable, the retry budget isn't used up, enough time remains, and the run
 * hasn't broken down (at least 2 chunks failed and more than half of them).
 * Each chunk is retried at most once. Results come back in input order; a
 * chunk that never succeeded is null.
 */
export async function runChunks<C, T>(
  chunks: C[],
  call: (chunk: C, attempt: number, timeoutMs: number) => Promise<ChunkOutcome<T>>,
  opts: RunOptions<C>,
): Promise<ChunkResult<T>[]> {
  const startedAt = Date.now();
  const n = chunks.length;
  let failed = 0;
  let retriesUsed = 0;
  let brokenDownReported = false;

  const settle = async (chunk: C, attempt: number, timeoutMs: number): Promise<ChunkOutcome<T>> => {
    try {
      return await call(chunk, attempt, timeoutMs);
    } catch (err) {
      // `call` should never throw, but a bug in it must not fail the request.
      return { ok: false, reason: err instanceof Error ? err.message : String(err), retryable: false };
    }
  };

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runOne = async (chunk: C): Promise<ChunkResult<T>> => {
    const label = opts.label(chunk);
    const first = await settle(chunk, 1, Math.max(1, Math.min(opts.remaining(), opts.firstAttemptMs)));
    if (first.ok) return { value: first.value, attempts: 1, ms: Date.now() - startedAt };

    failed++;
    const delay = first.retryAfterMs ?? 0;
    if (!first.retryable) {
      opts.diag.warn(`${label}: ${first.reason}, not retrying`);
    } else if (failed >= 2 && failed > n / 2) {
      if (!brokenDownReported) {
        brokenDownReported = true;
        opts.diag.warn(`${failed} of ${n} chunks failed, not retrying`);
      }
    } else if (retriesUsed >= opts.maxRetries) {
      opts.diag.warn(`Retry budget used; ${label.toLowerCase()} stays as original text`);
    } else if (opts.remaining() - delay < opts.minRetryMs) {
      opts.diag.error(`No time left to retry ${label.toLowerCase()}`);
    } else {
      retriesUsed++;
      if (delay > 0) await wait(delay);
      opts.diag.warn(`Retrying ${label.toLowerCase()}`);
      const second = await settle(chunk, 2, Math.max(1, opts.remaining()));
      return { value: second.ok ? second.value : null, attempts: 2, ms: Date.now() - startedAt };
    }
    return { value: null, attempts: 1, ms: Date.now() - startedAt };
  };

  return Promise.all(chunks.map(runOne));
}
