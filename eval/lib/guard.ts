// Live-call guard. Evals spend real money, so a live upstream call is refused
// unless all three are set:
//   - EVAL=1 and EVAL_YES=1, which eval/vitest.config.ts takes from the shell
//     only (never from .env files);
//   - EVAL_HARNESS=1, which only eval/vitest.config.ts sets. A root
//     `npx vitest run` therefore can never go live, whatever the shell says.
// eval/setup.ts installs guardFetch over globalThis.fetch for the whole eval
// worker, so code outside runSuite (beforeAll, a direct swap()) is guarded too.

import { createHash } from 'node:crypto';

export type Env = Record<string, string | undefined>;

export class LiveCallRefused extends Error {
  constructor(what: string, why = 'set EVAL=1 and EVAL_YES=1 in the shell and run through `npm run eval`') {
    super(`Refusing live call (${what}): ${why}.`);
    this.name = 'LiveCallRefused';
  }
}

export function liveCallsAllowed(env: Env = process.env): boolean {
  return env.EVAL === '1' && env.EVAL_YES === '1' && env.EVAL_HARNESS === '1';
}

export function assertLiveCallsAllowed(what: string, env: Env = process.env): void {
  if (!liveCallsAllowed(env)) throw new LiveCallRefused(what);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comma-separated sha256 hashes of the app keys, set by the eval config (the keys themselves are blanked). */
export const APP_KEY_HASHES_VAR = 'EVAL_APP_KEY_SHA256';

export function describeUrl(input: Parameters<typeof fetch>[0]): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`; // drop the query string
  } catch {
    return String(raw).split('?')[0];
  }
}

function bearer(input: Parameters<typeof fetch>[0], init?: RequestInit): string | undefined {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
  const auth = headers.get('authorization');
  return auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
}

/**
 * Wraps a fetch so that every call is refused unless live calls are allowed
 * (read from `env` at call time), and a call carrying an app key is refused
 * even then.
 */
export function guardFetch(inner: typeof fetch, env: Env = process.env): typeof fetch {
  return async (input, init) => {
    const url = describeUrl(input);
    assertLiveCallsAllowed(url, env);
    const key = bearer(input, init);
    const appHashes = (env[APP_KEY_HASHES_VAR] ?? '').split(',').filter(Boolean);
    if (key && appHashes.includes(sha256(key))) {
      throw new LiveCallRefused(url, 'the request carries the app key; evals may only use EVAL_LLM_API_KEY');
    }
    return inner(input, init);
  };
}
