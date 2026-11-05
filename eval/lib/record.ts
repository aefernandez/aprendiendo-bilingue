// Fetch recorder. Wraps a fetch implementation so every upstream call made
// while an eval item runs is recorded against that item, even when items run
// concurrently (AsyncLocalStorage). The wrapper:
//   - refuses the call unless EVAL=1 && EVAL_YES=1 (guard.ts);
//   - records wall time (to the end of a JSON body) and HTTP status;
//   - reads `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cost`,
//     top-level `provider`, `id` and `model` from a JSON body only if present
//     (OpenRouter returns `usage` on every response; `provider` isn't documented,
//     so it may be missing). Non-JSON and streaming bodies are fine.
// It never records headers (Authorization) or request/response bodies.

import { AsyncLocalStorage } from 'node:async_hooks';
import { assertLiveCallsAllowed, type Env } from './guard';

export interface CallUsage {
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

export interface CallRecord {
  url: string;
  method: string;
  status?: number;
  ms: number;
  provider?: string;
  generationId?: string;
  model?: string;
  usage?: CallUsage;
  error?: string;
  /** The guard refused this call; nothing was sent. */
  refused?: boolean;
}

type Fetch = typeof fetch;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Picks the recorded fields out of a parsed response body. Every field is optional. */
export function readResponseFields(body: unknown): Pick<CallRecord, 'provider' | 'generationId' | 'model' | 'usage'> {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: Pick<CallRecord, 'provider' | 'generationId' | 'model' | 'usage'> = {};
  if (str(b.provider)) out.provider = str(b.provider);
  if (str(b.id)) out.generationId = str(b.id);
  if (str(b.model)) out.model = str(b.model);
  if (b.usage && typeof b.usage === 'object') {
    const u = b.usage as Record<string, unknown>;
    const usage: CallUsage = {};
    if (num(u.prompt_tokens) !== undefined) usage.promptTokens = num(u.prompt_tokens);
    if (num(u.completion_tokens) !== undefined) usage.completionTokens = num(u.completion_tokens);
    if (num(u.cost) !== undefined) usage.cost = num(u.cost);
    if (Object.keys(usage).length) out.usage = usage;
  }
  return out;
}

function describeUrl(input: Parameters<Fetch>[0]): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`; // drop the query string
  } catch {
    return String(raw).split('?')[0];
  }
}

export interface Recorder {
  /** The guarded, recording fetch. Install it as globalThis.fetch for engine code. */
  fetch: Fetch;
  /** Runs fn and returns the upstream calls it made. */
  capture<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; calls: CallRecord[] }>;
}

export function createRecorder(inner: Fetch, env: Env = process.env, now: () => number = () => performance.now()): Recorder {
  const store = new AsyncLocalStorage<CallRecord[]>();

  const recordingFetch: Fetch = async (input, init) => {
    const url = describeUrl(input);
    const record: CallRecord = { url, method: init?.method ?? 'GET', ms: 0 };
    store.getStore()?.push(record);
    try {
      assertLiveCallsAllowed(url, env);
    } catch (err) {
      // Recorded so the runner notices even if engine code swallows the error.
      record.refused = true;
      record.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    const t0 = now();
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      record.ms = now() - t0;
      record.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    record.status = response.status;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      try {
        Object.assign(record, readResponseFields(await response.clone().json()));
      } catch {
        // Not valid JSON after all; nothing to read.
      }
    }
    // Until the full body for JSON responses, until headers otherwise.
    record.ms = now() - t0;
    return response;
  };

  return {
    fetch: recordingFetch,
    async capture(fn) {
      const calls: CallRecord[] = [];
      try {
        const value = await store.run(calls, fn);
        return { value, calls };
      } catch (error) {
        return { error, calls };
      }
    },
  };
}
