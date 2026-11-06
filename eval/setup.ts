// setupFiles for eval/vitest.config.ts: guard every fetch in the eval worker,
// not only the ones runSuite makes. See lib/guard.ts.
import { guardFetch } from './lib/guard';

globalThis.fetch = guardFetch(globalThis.fetch.bind(globalThis));
