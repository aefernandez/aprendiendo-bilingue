// Generic parallel fan-out for chunked model calls, with a shared deadline and
// a small per-request budget of extra requests. Knows nothing about prompts or
// responses: the engine (tagger today, B3's span engine later) supplies `call`.

import type { Diagnostics } from './diagnostics';

export type ChunkFailure = {
  ok: false;
  reason: string;
  retryable: boolean;
  // Wait this long before retrying (e.g. an in-flight budget).
  retryAfterMs?: number;
  // The model answered but the reply was unusable (wrong count, bad JSON):
  // the retry should use the stricter prompt.
  invalidReply?: boolean;
};

export type ChunkOutcome<T> = { ok: true; value: T } | ChunkFailure;

export interface ChunkResult<T> {
  value: T | null;
  // Requests sent for this chunk (1, or 2 with a retry or hedge).
  attempts: number;
  // Whether a second request was sent because the first was slow.
  hedged: boolean;
  // Time from the start of the run until this chunk settled.
  ms: number;
}

export type ChunkCall<C, T> = (
  chunk: C,
  attempt: number,
  timeoutMs: number,
  signal: AbortSignal,
  // Why the previous request for this chunk failed (absent for attempt 1
  // and for a hedge).
  previous?: ChunkFailure,
) => Promise<ChunkOutcome<T>>;

export interface RunOptions<C> {
  // Milliseconds left in the request's budget.
  remaining: () => number;
  // If a chunk's first request hasn't answered after this long, send a second
  // one alongside it (a hedge) and keep whichever valid reply comes first.
  // The first request is never cancelled for being slow.
  hedgeAfterMs: number;
  // Extra requests (retries + hedges) across all chunks in this run.
  maxRetries: number;
  // Don't start an extra request with less than this much time left.
  minRetryMs: number;
  diag: Diagnostics;
  // How the chunk is named in diagnostics, e.g. "Chunk 3/10".
  label: (chunk: C) => string;
}

/**
 * Starts every chunk's first request at once, each allowed the whole
 * remaining budget. A chunk gets at most one extra request:
 * - a retry, as soon as its first request fails (if the failure is retryable), or
 * - a hedge, when its first request is still running after `hedgeAfterMs`.
 * Either needs budget left, enough time left, and the run not to have broken
 * down (at least 2 chunks failed and more than half of them). The first valid
 * reply wins and the other request is aborted. Results come back in input
 * order; a chunk that never succeeded is null.
 */
export async function runChunks<C, T>(
  chunks: C[],
  call: ChunkCall<C, T>,
  opts: RunOptions<C>,
): Promise<ChunkResult<T>[]> {
  const startedAt = Date.now();
  const n = chunks.length;
  let failed = 0;
  let retriesUsed = 0;
  let brokenDownReported = false;
  const brokenDown = () => failed >= 2 && failed > n / 2;

  const runOne = (chunk: C) =>
    new Promise<ChunkResult<T>>((resolve) => {
      const label = opts.label(chunk);
      const controllers: AbortController[] = [];
      let attempts = 0;
      let inFlight = 0;
      let hedged = false;
      let countedFailure = false;
      let done = false;

      const finish = (value: T | null) => {
        if (done) return;
        done = true;
        clearTimeout(hedgeTimer);
        for (const c of controllers) c.abort();
        resolve({ value, attempts, hedged, ms: Date.now() - startedAt });
      };

      const launch = (attempt: number, previous?: ChunkFailure) => {
        attempts++;
        inFlight++;
        const controller = new AbortController();
        controllers.push(controller);
        let outcome: Promise<ChunkOutcome<T>>;
        try {
          outcome = call(chunk, attempt, Math.max(1, opts.remaining()), controller.signal, previous);
        } catch (err) {
          outcome = Promise.reject(err);
        }
        outcome
          // `call` should never throw, but a bug in it must not fail the request.
          .catch((err): ChunkOutcome<T> => ({
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
            retryable: false,
          }))
          .then((result) => {
            inFlight--;
            if (done) return;
            if (result.ok) finish(result.value);
            else onFailure(result);
          });
      };

      const onFailure = (failure: ChunkFailure) => {
        if (!countedFailure) {
          countedFailure = true;
          failed++;
        }
        // The other request (hedge or original) is still running: wait for it.
        if (inFlight > 0) return;
        if (attempts >= 2) return finish(null);

        clearTimeout(hedgeTimer);
        const delay = failure.retryAfterMs ?? 0;
        if (!failure.retryable) {
          opts.diag.warn(`${label}: ${failure.reason}, not retrying`);
        } else if (brokenDown()) {
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
          const retry = () => {
            opts.diag.warn(`Retrying ${label.toLowerCase()}`);
            launch(2, failure);
          };
          if (delay > 0) setTimeout(retry, delay);
          else retry();
          return;
        }
        finish(null);
      };

      // Declared last; the closures above only run after it is initialised
      // (call results always settle asynchronously).
      const hedgeTimer = setTimeout(() => {
        if (done || attempts >= 2) return;
        if (retriesUsed >= opts.maxRetries || brokenDown() || opts.remaining() < opts.minRetryMs) return;
        retriesUsed++;
        hedged = true;
        opts.diag.warn(`${label} is slow; sending a second request alongside it`);
        launch(2);
      }, opts.hedgeAfterMs);

      launch(1);
    });

  return Promise.all(chunks.map(runOne));
}
