// Test helper: make any unmocked network call fail loudly, so a broken mock can
// never fall through to a real (billed) API call.
import { afterEach, beforeEach, vi } from 'vitest';

export const throwingFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Unmocked fetch in a unit test: ${url}`);
};

export function installThrowingFetch(): void {
  beforeEach(() => {
    vi.stubGlobal('fetch', throwingFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
