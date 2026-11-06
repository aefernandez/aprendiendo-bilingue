// Test helper: make any unmocked network call fail loudly, so a broken mock can
// never fall through to a real (billed) API call.
import { afterEach, beforeEach } from 'vitest';

export const throwingFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Unmocked fetch in a unit test: ${url}`);
};

// Restores exactly the fetch it replaced. It must not call vi.unstubAllGlobals(),
// which would also remove other stubs, such as a root-wide fetch guard.
export function installThrowingFetch(): void {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
    globalThis.fetch = throwingFetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
  });
}
