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
// - Spend is the max of spend.jsonl and the costs in every calls.jsonl, so
//   deleting spend.jsonl doesn't reset the cap. Calls without usage (timeouts,
//   aborts) are priced at the estimate. Before each item, the item and all
//   items in flight are reserved against the cap.
// - It stops if the upstream reports a different model than the plan priced.
// - Only one runSuite may run per process.
// - While items run, globalThis.fetch is replaced by the recorder's guarded
//   fetch, so engine code is recorded without changes.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { callCost, estimateCost, formatUsd, type CostEstimate, type TokenEstimate } from './cost';
import { LiveCallRefused, liveCallsAllowed, type Env } from './guard';
import { SpendLedger, appendLine, readCap } from './ledger';
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

export type RunStatus = 'dry-run' | 'refused-budget' | 'complete' | 'aborted-budget' | 'aborted-model' | 'incomplete';

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

const COST_RANK = ['none', 'usage', 'tokens', 'estimate'] as const;

/**
 * Cost of an item's calls. usage.cost when present; else priced from usage
 * tokens; else (no usage: timeouts, aborts, errors, non-JSON) the estimate,
 * because OpenRouter may bill a request the provider had started.
 */
function itemCost(item: PlanItem, calls: CallRecord[]): Pick<ItemLine, 'costUsd' | 'costSource'> {
  const sent = calls.filter((c) => !c.refused);
  let usd = 0;
  let source: ItemLine['costSource'] = sent.length ? 'usage' : 'none';
  const note = (s: ItemLine['costSource']) => {
    if (COST_RANK.indexOf(s) > COST_RANK.indexOf(source)) source = s;
  };
  for (const c of sent) {
    if (c.usage?.cost !== undefined && c.usage.cost >= 0) {
      usd += c.usage.cost;
    } else if (c.usage?.promptTokens !== undefined || c.usage?.completionTokens !== undefined) {
      usd += callCost(c.model ?? item.model, {
        promptTokens: c.usage.promptTokens ?? 0,
        completionTokens: c.usage.completionTokens ?? 0,
      });
      note('tokens');
    } else {
      usd += callCost(item.model, item.estimate);
      note('estimate');
    }
  }
  return { costUsd: usd, costSource: source };
}

/** Exact match only: any other served model means the estimate priced the wrong model. */
export function sameModel(planned: string, served: string): boolean {
  return served === planned;
}

/** Sum of costUsd over every run's calls.jsonl: a floor for spend if spend.jsonl was deleted. */
export function recordedSpend(resultsDir: string): number {
  if (!existsSync(resultsDir)) return 0;
  let usd = 0;
  for (const d of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const l of readLines(path.join(resultsDir, d.name, 'calls.jsonl'))) {
      if (Number.isFinite(l.costUsd)) usd += l.costUsd;
    }
  }
  return usd;
}

// One runSuite per process: it swaps globalThis.fetch, so two at once would
// misattribute calls and restore the wrong fetch.
let active = false;

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
  if (active) throw new Error('runSuite is already running in this process; run suites one after another.');
  active = true;
  try {
    return await runSuiteInner(opts);
  } finally {
    active = false;
  }
}

async function runSuiteInner<I extends PlanItem>(opts: RunOptions<I>): Promise<RunResult> {
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
  const ledgerBefore = Math.max(ledger.spent(), recordedSpend(resultsDir));
  const base = { estimate, lines: [] as ItemLine[], spentUsd: 0, capUsd };

  log(`Suite ${opts.suite}: ${opts.items.length} items, ~${estimate.promptTokens} prompt + ~${estimate.completionTokens} completion tokens.`);
  log(
    `Estimated cost ${formatUsd(estimate.usd)} (price table${estimate.stale ? ' may be STALE' : ''}` +
      `${estimate.unknownModels.length ? `; unknown models priced high: ${estimate.unknownModels.join(', ')}` : ''}).`,
  );
  log(`Eval ledger so far: ${formatUsd(ledgerBefore)} of ${formatUsd(capUsd)} cap (EVAL_MAX_USD).`);

  if (!liveCallsAllowed(env)) {
    log('Dry run: no calls made. Re-run with EVAL=1 EVAL_YES=1 (in the shell) via `npm run eval` to execute.');
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
  let finished = 0;
  let inFlight = 0;
  let abortedBudget = false;
  let modelMismatch: string | undefined;
  let resultsVanished = false;
  let refused: LiveCallRefused | undefined;
  // Never below what this process has seen, even if spend.jsonl is deleted mid-run.
  const spentNow = () => Math.max(ledger.spent(), ledgerBefore + spentUsd);

  try {
    await pool(pending, opts.concurrency ?? 1, async (item) => {
      // Reserve this item and every item in flight at max(estimate, average actual so far).
      const reserve = Math.max(callCost(item.model, item.estimate), finished ? spentUsd / finished : 0);
      if (spentNow() + (inFlight + 1) * reserve > capUsd) {
        abortedBudget = true;
        return false;
      }
      if (!existsSync(dir)) {
        resultsVanished = true;
        return false;
      }
      inFlight++;
      const { value, error, calls } = await recorder.capture(() => opts.execute(item)).finally(() => inFlight--);
      const cost = itemCost(item, calls);
      if (!existsSync(dir)) {
        // Someone deleted results/ (and the ledger in it): keep the in-memory floor and stop.
        spentUsd += cost.costUsd;
        resultsVanished = true;
        return false;
      }
      const refusedCall = calls.find((c) => c.refused);
      if (error instanceof LiveCallRefused || refusedCall) {
        refused = error instanceof LiveCallRefused ? error : new LiveCallRefused(refusedCall!.url);
      }
      const wrongModel = calls.find((c) => c.model && !sameModel(item.model, c.model));
      if (wrongModel) modelMismatch = `planned ${item.model}, served ${wrongModel.model}`;
      const line: ItemLine = {
        key: item.key,
        status: error === undefined && !refused && !wrongModel ? 'ok' : 'error',
        ...(error === undefined
          ? { value }
          : { error: error instanceof Error ? error.message : String(error) }),
        ...(wrongModel ? { error: `model mismatch: ${modelMismatch}` } : {}),
        calls,
        ...cost,
        ts: new Date().toISOString(),
      };
      appendLine(callsFile, JSON.stringify(line));
      if (cost.costUsd > 0) ledger.record({ runId, key: item.key, usd: cost.costUsd });
      spentUsd += cost.costUsd;
      finished++;
      done.set(item.key, line);
      return !refused && !modelMismatch;
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
  if (refused) throw refused;
  if (resultsVanished) {
    throw new Error(`Results directory ${dir} vanished mid-run; refusing to continue (spend so far: ${formatUsd(spentNow())}).`);
  }

  const lines = opts.items.map((i) => done.get(i.key)).filter((l): l is ItemLine => !!l);
  const complete = lines.length === opts.items.length && lines.every((l) => l.status === 'ok');
  if (complete) writeMeta(dir, { ...meta, finished: true });
  const status: RunStatus = complete
    ? 'complete'
    : modelMismatch
      ? 'aborted-model'
      : abortedBudget
        ? 'aborted-budget'
        : 'incomplete';
  const ledgerUsd = spentNow();
  log(`Run ${runId}: ${status}; spent ${formatUsd(spentUsd)} this session, ledger ${formatUsd(ledgerUsd)}.`);
  if (abortedBudget) log('Stopped at the EVAL_MAX_USD cap. Re-run the same command after raising it to resume.');
  if (modelMismatch) log(`Stopped: ${modelMismatch}. Plan items with the model the engine actually uses (evalModel()).`);
  return { status, estimate, runId, dir, lines, spentUsd, ledgerUsd, capUsd };
}
