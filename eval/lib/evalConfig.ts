// Pure helpers for eval/vitest.config.ts: pick exactly one suite from the CLI
// and build the test environment. Kept here so they can be unit-tested.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { APP_KEY_HASHES_VAR, sha256 } from './guard';

type Env = Record<string, string | undefined>;

// vitest options that take a separate value (`--config eval/vitest.config.ts`).
const VALUE_FLAGS = new Set([
  '--config', '-c', '--root', '-r', '--dir', '--mode', '--reporter', '--outputFile', '--project',
  '--testNamePattern', '-t', '--environment', '--pool', '--shard', '--maxWorkers', '--retry',
  '--bail', '--testTimeout', '--hookTimeout', '--exclude', '--sequence.seed', '--slowTestThreshold',
]);
const COMMANDS = new Set(['run', 'watch', 'dev', 'related']);

/** Positional filters from a vitest argv (everything after the node binary and script). */
export function suiteFilters(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (out.length === 0 && COMMANDS.has(a)) continue;
    out.push(a);
  }
  return out;
}

export function listSuites(evalDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === 'results') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.eval.ts')) found.push(p);
    }
  };
  walk(evalDir);
  return found.sort();
}

/** Requires exactly one filter matching exactly one suite file; returns its path. */
export function selectSuite(filters: string[], suites: string[], root: string): string {
  const names = suites.map((s) => path.relative(root, s));
  const available = names.length ? names.join(', ') : '(none yet)';
  if (filters.length !== 1) {
    throw new Error(
      `npm run eval needs exactly one suite, e.g. \`npm run eval -- baseline\` (got ${filters.length}). Available: ${available}`,
    );
  }
  const f = filters[0];
  const exact = suites.filter((s) => path.basename(s) === `${f}.eval.ts`);
  const matches = exact.length ? exact : suites.filter((s) => path.relative(root, s).includes(f));
  if (matches.length !== 1) {
    throw new Error(`Suite "${f}" matches ${matches.length} eval files; it must match exactly one. Available: ${available}`);
  }
  return matches[0];
}

/** Reads .env, .env.local, .env.eval, .env.eval.local from the repo root (later files win). */
export function readEnvFiles(root: string): Env {
  const env: Env = {};
  for (const name of ['.env', '.env.local', '.env.eval', '.env.eval.local']) {
    const file = path.join(root, name);
    if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file, 'utf8')));
  }
  return env;
}

/**
 * The env for eval workers. Files can supply only ordinary settings and
 * EVAL_LLM_API_KEY; everything that can switch on or redirect spend comes from
 * the shell:
 * - EVAL, EVAL_YES and EVAL_MAX_USD: shell only. EVAL_HARNESS=1 marks the eval
 *   config, and the guard requires it.
 * - The engine key (LLM_API_KEY) is EVAL_LLM_API_KEY only when the shell has
 *   EVAL=1 and EVAL_YES=1; otherwise it is blank, so a dry run can't spend.
 *   EVAL_LLM_API_KEY itself is never passed on.
 * - The app keys are blanked, and their sha256 hashes are passed so the guard
 *   refuses any request that carries one.
 * - Model and base URL: EVAL_LLM_MODEL / EVAL_LLM_BASE_URL from the shell, else
 *   the engine defaults. The app's LLM_MODEL / LLM_BASE_URL in .env.local are ignored.
 */
export function buildEvalEnv(fileEnv: Env, shellEnv: Env): Record<string, string> {
  const merged: Env = { ...fileEnv };
  for (const [k, v] of Object.entries(shellEnv)) if (v !== undefined) merged[k] = v;
  const live = shellEnv.EVAL === '1' && shellEnv.EVAL_YES === '1';
  const evalKey = merged.EVAL_LLM_API_KEY?.trim() ?? '';
  const appKeys = [fileEnv.LLM_API_KEY, fileEnv.OPENROUTER_API_KEY, shellEnv.LLM_API_KEY, shellEnv.OPENROUTER_API_KEY]
    .map((k) => k?.trim())
    .filter((k): k is string => !!k);
  if (evalKey && appKeys.includes(evalKey)) {
    throw new Error('EVAL_LLM_API_KEY is the same as the app key. Create a separate, capped OpenRouter key for evals.');
  }

  merged.EVAL = shellEnv.EVAL ?? '';
  merged.EVAL_YES = shellEnv.EVAL_YES ?? '';
  merged.EVAL_MAX_USD = shellEnv.EVAL_MAX_USD ?? '';
  merged.EVAL_HARNESS = '1';
  merged.LLM_API_KEY = live ? evalKey : '';
  merged.EVAL_LLM_API_KEY = '';
  merged.OPENROUTER_API_KEY = '';
  merged[APP_KEY_HASHES_VAR] = [...new Set(appKeys.map(sha256))].join(',');
  merged.LLM_MODEL = shellEnv.EVAL_LLM_MODEL ?? '';
  merged.LLM_BASE_URL = shellEnv.EVAL_LLM_BASE_URL ?? '';
  merged.OPENROUTER_MODEL = '';
  merged.OPENROUTER_BASE_URL = '';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) out[k] = v;
  return out;
}
