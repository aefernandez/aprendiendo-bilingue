// Config for live eval suites (`npm run eval -- <suite>`), separate from the
// normal test run. Root `npx vitest run` never sees *.eval.ts files because
// vitest's default include only matches *.test.* / *.spec.*.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { buildEvalEnv, listSuites, readEnvFiles, selectSuite, suiteFilters } from './lib/evalConfig';

const evalDir = fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(evalDir, '..');
const suite = selectSuite(suiteFilters(process.argv.slice(2)), listSuites(evalDir), root);

export default defineConfig({
  root,
  resolve: { alias: { '@': root } },
  test: {
    include: [path.relative(root, suite)],
    // Installs the guarded fetch for the whole worker (see lib/guard.ts).
    setupFiles: [path.join(evalDir, 'setup.ts')],
    // A re-run spends again; never re-run on file changes.
    watch: false,
    fileParallelism: false,
    testTimeout: 0,
    hookTimeout: 0,
    env: buildEvalEnv(readEnvFiles(root), process.env),
  },
});
