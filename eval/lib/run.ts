// Suite runner: plan → cost estimate → (dry run | execute with resume and $ cap).
//
// - Without EVAL=1 && EVAL_YES=1 it prints the plan and estimate and makes no
//   calls (dry run).
// - It refuses to start when ledger spend + estimate would exceed EVAL_MAX_USD,
//   and stops scheduling new items once the shared ledger reaches the cap.
// - Each finished item appends one line to results/<runId>/calls.jsonl.
//   Re-running the same command resumes the newest unfinished run of the same
//   suite whose config hash matches; EVAL_RUN=<id> picks a run, EVAL_FRESH=1
//   starts a new one. Items whose last line is an error are retried.
// - While items run, globalThis.fetch is replaced by the recorder's guarded
//   fetch, so engine code is recorded without changes.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { callCost, estimateCost, formatUsd, type CostEstimate, type TokenEstimate } from './cost';
import { LiveCallRefused, liveCallsAllowed, type Env } from './guard';
import { SpendLedger, readCap } from './ledger';
import { createRecorder, type CallRecord } from './record';

export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

export interface PlanItem {
  /** Unique within the suite, e.g. `baseline|en-news-1|en-it|L1|r2`. */
  key: string;
  model: string;
  /** Estimated tokens for ALL upstream calls this item makes. */
  estimate: TokenEstimate;
}

export interface ItemLine {
  key: string;
  status: 'ok' | 'error';
  value?: unknown;
  error?: string;
  calls: CallRecord[];
  costUsd: number;
  /** usage = from usage.cost; tokens = priced from usage tokens; estimate = no usage returned. */
  costSource: 'usage' | 'tokens' | 'estimate' | 'none';
  ts: string;
}

export interface RunMeta {
  runId: string;
  suite: string;
  configHash: string;
  config: unknown;
  createdAt: string;
  items: number;
  finished: boolean;
}

export interface RunOptions<I extends PlanItem> {
  suite: string;
  /** Everything that changes results (model, levels, reps, prompt version...). Hashed for resume. */
  config: unknown;
  items: I[];
  execute: (item: I) => Promise<unknown>;
  env?: Env;
  resultsDir?: string;
  concurrency?: number;
  log?: (line: string) => void;
  /** The fetch that the recorder wraps; defaults to the current globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type RunStatus = 'dry-run' | 'refused-budget' | 'complete' | 'aborted-budget' | 'incomplete';

export interface RunResult {
  status: RunStatus;
  estimate: CostEstimate;
  runId?: string;
  dir?: string;
  /** Latest line per key, in plan order (including lines from earlier, resumed sessions). */
  lines: ItemLine[];
  /** Spend in this session. */
  spentUsd: number;
  ledgerUsd: number;
  capUsd: number;
}

export function configHash(suite: string, config: unknown): string {
  return createHash('sha256').update(JSON.stringify({ suite, config })).digest('hex').slice(0, 12);
}

export function readLines(file: string): ItemLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ItemLine];
      } catch {
        return []; // torn line after Ctrl-C: that item simply re-runs
      }
    });
}

function latestByKey(lines: ItemLine[]): Map<string, ItemLine> {
  const map = new Map<string, ItemLine>();
  for (const l of lines) map.set(l.key, l);
  return map;
}

function readMeta(dir: string): RunMeta | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as RunMeta;
  } catch {
    return undefined;
  }
}

function writeMeta(dir: string, meta: RunMeta): void {
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
}

function newRunId(suite: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `${suite}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Picks the run directory: EVAL_RUN, else (unless EVAL_FRESH) the newest unfinished matching run, else new. */
export function selectRun(
  resultsDir: string,
  suite: string,
  hash: string,
  env: Env,
): { runId: string; resumed: boolean } {
  const requested = env.EVAL_RUN?.trim();
  if (requested) {
    const meta = readMeta(path.join(resultsDir, requested));
    if (!meta) throw new Error(`EVAL_RUN=${requested}: no such run in ${resultsDir}`);
    if (meta.suite !== suite || meta.configHash !== hash) {
      throw new Error(`EVAL_RUN=${requested} is a different suite or config (hash ${meta.configHash}, now ${hash})`);
    }
    return { runId: requested, resumed: true };
  }
  if (env.EVAL_FRESH !== '1' && existsSync(resultsDir)) {
    const candidates = readdirSync(resultsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readMeta(path.join(resultsDir, d.name)))
      .filter((m): m is RunMeta => !!m && m.suite === suite && m.configHash === hash && !m.finished)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (candidates[0]) return { runId: candidates[0].runId, resumed: true };
  }
  return { runId: newRunId(suite), resumed: false };
}

function itemCost(item: PlanItem, calls: CallRecord[]): Pick<ItemLine, 'costUsd' | 'costSource'> {
  if (calls.length === 0) return { costUsd: 0, costSource: 'none' };
  let usd = 0;
  let source: ItemLine['costSource'] = 'usage';
  const rank = { none: 0, usage: 1, tokens: 2, estimate: 3 } as const;
  const worse = (s: ItemLine['costSource']) => {
    if (rank[s] > rank[source]) source = s;
  };
  const perCallEstimate = callCost(item.model, item.estimate) / calls.length;
  for (const c of calls) {
    if (c.usage?.cost !== undefined) {
      usd += c.usage.cost;
    } else if (c.usage?.promptTokens !== undefined || c.usage?.completionTokens !== undefined) {
      usd += callCost(c.model ?? item.model, {
        promptTokens: c.usage.promptTokens ?? 0,
        completionTokens: c.usage.completionTokens ?? 0,
      });
      worse('tokens');
    } else if (c.status !== undefined && c.status < 400) {
      // A successful call without usage: assume the estimate (errs high).
      usd += perCallEstimate;
      worse('estimate');
    } else if (c.status === undefined && !c.error) {
      usd += perCallEstimate;
      worse('estimate');
    }
  }
  return { costUsd: usd, costSource: source };
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<boolean>): Promise<void> {
  let next = 0;
  let stop = false;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!stop && next < items.length) {
      const item = items[next++];
      if (!(await worker(item))) stop = true;
    }
  });
  await Promise.all(lanes);
}

export async function runSuite<I extends PlanItem>(opts: RunOptions<I>): Promise<RunResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const resultsDir = opts.resultsDir ?? RESULTS_DIR;
  const ledger = new SpendLedger(path.join(resultsDir, 'spend.jsonl'));
  const capUsd = readCap(env);

  const keys = new Set<string>();
  for (const item of opts.items) {
    if (keys.has(item.key)) throw new Error(`Duplicate plan key: ${item.key}`);
    keys.add(item.key);
  }

  const estimate = estimateCost(opts.items.map((i) => ({ model: i.model, ...i.estimate })));
  const ledgerBefore = ledger.spent();
  const base = { estimate, lines: [] as ItemLine[], spentUsd: 0, capUsd };

  log(`Suite ${opts.suite}: ${opts.items.length} items, ~${estimate.promptTokens} prompt + ~${estimate.completionTokens} completion tokens.`);
  log(
    `Estimated cost ${formatUsd(estimate.usd)} (price table${estimate.stale ? ' may be STALE' : ''}` +
      `${estimate.unknownModels.length ? `; unknown models priced high: ${estimate.unknownModels.join(', ')}` : ''}).`,
  );
  log(`Eval ledger so far: ${formatUsd(ledgerBefore)} of ${formatUsd(capUsd)} cap (EVAL_MAX_USD).`);

  if (!liveCallsAllowed(env)) {
    log('Dry run: no calls made. Re-run with EVAL=1 EVAL_YES=1 to execute.');
    return { ...base, status: 'dry-run', ledgerUsd: ledgerBefore };
  }

  const hash = configHash(opts.suite, opts.config);
  const { runId, resumed } = selectRun(resultsDir, opts.suite, hash, env);
  const dir = path.join(resultsDir, runId);
  const callsFile = path.join(dir, 'calls.jsonl');
  const done = latestByKey(readLines(callsFile));
  const pending = opts.items.filter((i) => done.get(i.key)?.status !== 'ok');

  const pendingEstimate = estimateCost(pending.map((i) => ({ model: i.model, ...i.estimate })));
  if (ledgerBefore + pendingEstimate.usd > capUsd) {
    log(
      `Refusing to start: ledger ${formatUsd(ledgerBefore)} + estimate ${formatUsd(pendingEstimate.usd)} ` +
        `exceeds the ${formatUsd(capUsd)} cap. Raise EVAL_MAX_USD if this is intended.`,
    );
    return { ...base, status: 'refused-budget', runId, ledgerUsd: ledgerBefore };
  }

  mkdirSync(dir, { recursive: true });
  const meta: RunMeta = readMeta(dir) ?? {
    runId,
    suite: opts.suite,
    configHash: hash,
    config: opts.config,
    createdAt: new Date().toISOString(),
    items: opts.items.length,
    finished: false,
  };
  writeMeta(dir, meta);
  log(`${resumed ? 'Resuming' : 'Starting'} run ${runId}: ${pending.length} of ${opts.items.length} items to do.`);

  const recorder = createRecorder(opts.fetchImpl ?? globalThis.fetch, env);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = recorder.fetch;
  let spentUsd = 0;
  let abortedBudget = false;
  let refused: LiveCallRefused | undefined;

  try {
    await pool(pending, opts.concurrency ?? 1, async (item) => {
      if (ledger.spent() >= capUsd) {
        abortedBudget = true;
        return false;
      }
      const { value, error, calls } = await recorder.capture(() => opts.execute(item));
      const cost = itemCost(item, calls);
      if (error instanceof LiveCallRefused || calls.some((c) => c.refused)) {
        refused = error instanceof LiveCallRefused ? error : new LiveCallRefused(calls.find((c) => c.refused)!.url);
        return false;
      }
      const line: ItemLine = {
        key: item.key,
        status: error === undefined ? 'ok' : 'error',
        ...(error === undefined
          ? { value }
          : { error: error instanceof Error ? error.message : String(error) }),
        calls,
        ...cost,
        ts: new Date().toISOString(),
      };
      appendFileSync(callsFile, JSON.stringify(line) + '\n');
      if (cost.costUsd > 0) ledger.record({ runId, key: item.key, usd: cost.costUsd });
      spentUsd += cost.costUsd;
      done.set(item.key, line);
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
  if (refused) throw refused;

  const lines = opts.items.map((i) => done.get(i.key)).filter((l): l is ItemLine => !!l);
  const complete = lines.length === opts.items.length && lines.every((l) => l.status === 'ok');
  if (complete) writeMeta(dir, { ...meta, finished: true });
  const status: RunStatus = complete ? 'complete' : abortedBudget ? 'aborted-budget' : 'incomplete';
  const ledgerUsd = ledger.spent();
  log(`Run ${runId}: ${status}; spent ${formatUsd(spentUsd)} this session, ledger ${formatUsd(ledgerUsd)}.`);
  if (abortedBudget) log('Stopped at the EVAL_MAX_USD cap. Re-run the same command after raising it to resume.');
  return { status, estimate, runId, dir, lines, spentUsd, ledgerUsd, capUsd };
}
