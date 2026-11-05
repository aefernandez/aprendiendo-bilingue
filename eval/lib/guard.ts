// Live-call guard. Evals spend real money, so a live upstream call is refused
// unless BOTH EVAL=1 and EVAL_YES=1 are set in the shell. eval/vitest.config.ts
// takes these two from the shell only, never from .env files.

export type Env = Record<string, string | undefined>;

export class LiveCallRefused extends Error {
  constructor(what: string) {
    super(`Refusing live call (${what}): set EVAL=1 and EVAL_YES=1 to make real LLM calls.`);
    this.name = 'LiveCallRefused';
  }
}

export function liveCallsAllowed(env: Env = process.env): boolean {
  return env.EVAL === '1' && env.EVAL_YES === '1';
}

export function assertLiveCallsAllowed(what: string, env: Env = process.env): void {
  if (!liveCallsAllowed(env)) throw new LiveCallRefused(what);
}
