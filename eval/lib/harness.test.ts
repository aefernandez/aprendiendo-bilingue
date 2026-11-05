import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swap } from '../../lib/swapEngine';
import { callCost, estimateCost, estimateTokens, evalModel } from './cost';
import { buildEvalEnv, selectSuite, suiteFilters } from './evalConfig';
import { APP_KEY_HASHES_VAR, LiveCallRefused, assertLiveCallsAllowed, guardFetch, liveCallsAllowed, sha256 } from './guard';
import { SpendLedger, appendLine, readCap } from './ledger';
import { createRecorder, readResponseFields } from './record';
import { readLines, runSuite, type PlanItem } from './run';
import { renderSummary, writeSummary, type Summary } from './summary';
import { installThrowingFetch, throwingFetch } from './testing';

installThrowingFetch();

const LIVE = { EVAL: '1', EVAL_YES: '1', EVAL_HARNESS: '1' };
const MODEL = 'google/gemma-4-26b-a4b-it';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'eval-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function completion(cost: number | undefined, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      provider: 'Makora',
      model: MODEL,
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, ...(cost === undefined ? {} : { cost }) },
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const items = (n: number): PlanItem[] =>
  Array.from({ length: n }, (_, i) => ({ key: `s|f${i}`, model: MODEL, estimate: { promptTokens: 1000, completionTokens: 200 } }));

// An execute() that makes one upstream call through the global fetch, like engine code does.
const callUpstream = async (item: PlanItem) => {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions?x=1', { method: 'POST', body: item.key });
  return { status: res.status };
};

describe('unit-test network guard', () => {
  it('global fetch throws on unmocked calls', async () => {
    await expect(fetch('https://openrouter.ai/api/v1/models')).rejects.toThrow(/Unmocked fetch/);
  });
});

describe('live-call guard', () => {
  it.each([
    [{}, false],
    [{ EVAL: '1' }, false],
    [{ EVAL_YES: '1' }, false],
    [{ EVAL: 'true', EVAL_YES: '1', EVAL_HARNESS: '1' }, false],
    [{ EVAL: '1', EVAL_YES: '1' }, false], // root run: no EVAL_HARNESS, never live
    [LIVE, true],
  ])('%j → %s', (env, allowed) => {
    expect(liveCallsAllowed(env)).toBe(allowed);
    if (!allowed) expect(() => assertLiveCallsAllowed('x', env)).toThrow(LiveCallRefused);
  });
});

describe('cost', () => {
  it('estimates tokens and prices known and unknown models', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(callCost(MODEL, { promptTokens: 1e6, completionTokens: 1e6 })).toBeCloseTo(0.129);
    const e = estimateCost([
      { model: MODEL, promptTokens: 1e6, completionTokens: 0 },
      { model: 'x/unknown', promptTokens: 1e6, completionTokens: 0 },
    ]);
    expect(e.usd).toBeCloseTo(0.032 + 2);
    expect(e.unknownModels).toEqual(['x/unknown']);
    expect(e.stale).toBe(true);
  });
});

describe('ledger', () => {
  it('sums appended entries, skips torn lines and reads the cap', () => {
    const file = path.join(dir, 'spend.jsonl');
    const ledger = new SpendLedger(file);
    expect(ledger.spent()).toBe(0);
    ledger.record({ runId: 'r', key: 'a', usd: 0.25 });
    new SpendLedger(file).record({ runId: 'r2', key: 'b', usd: 0.5 }); // another process
    writeFileSync(file, readFileSync(file, 'utf8') + '{"usd": 9');
    expect(ledger.spent()).toBeCloseTo(0.75);
    // The next append must not land on the torn line.
    ledger.record({ runId: 'r3', key: 'c', usd: 1.5 });
    expect(ledger.spent()).toBeCloseTo(2.25);
    appendLine(path.join(dir, 'new.jsonl'), '{}');
    expect(readFileSync(path.join(dir, 'new.jsonl'), 'utf8')).toBe('{}\n');
    expect(readCap({})).toBe(2);
    expect(readCap({ EVAL_MAX_USD: '0.5' })).toBe(0.5);
    expect(() => readCap({ EVAL_MAX_USD: 'lots' })).toThrow();
  });
});

describe('recorder', () => {
  it('reads usage, provider and id only when present', () => {
    expect(readResponseFields({ id: 'g', provider: 'P', usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.1 } })).toEqual({
      generationId: 'g',
      provider: 'P',
      usage: { promptTokens: 3, completionTokens: 4, cost: 0.1 },
    });
    expect(readResponseFields({ choices: [] })).toEqual({});
    expect(readResponseFields('nope')).toEqual({});
  });

  it('attributes calls to the right item under concurrency and tolerates non-JSON bodies', async () => {
    const inner = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('text')
        ? new Response('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })
        : completion(0.001),
    );
    const rec = createRecorder(inner, LIVE);
    const [a, b] = await Promise.all([
      rec.capture(async () => {
        await rec.fetch('https://openrouter.ai/api/v1/chat/completions?secret=1');
        return 'a';
      }),
      rec.capture(async () => {
        await rec.fetch('https://example.com/text');
        await rec.fetch('https://openrouter.ai/api/v1/chat/completions');
        return 'b';
      }),
    ]);
    expect(a.value).toBe('a');
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', status: 200, provider: 'Makora', usage: { cost: 0.001 } });
    expect(b.calls.map((c) => c.status)).toEqual([401, 200]);
    expect(b.calls[0].usage).toBeUndefined();
  });

  it('refuses without EVAL=1 && EVAL_YES=1 and never calls the inner fetch', async () => {
    const inner = vi.fn<typeof fetch>();
    const rec = createRecorder(inner, { EVAL: '1' });
    const r = await rec.capture(() => rec.fetch('https://openrouter.ai/api/v1/chat/completions'));
    expect(r.error).toBeInstanceOf(LiveCallRefused);
    expect(r.calls[0].refused).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('runSuite', () => {
  const base = (extra: Partial<Parameters<typeof runSuite>[0]> = {}) => ({
    suite: 's',
    config: { v: 1 },
    items: items(3),
    execute: callUpstream,
    resultsDir: dir,
    log: () => {},
    ...extra,
  });

  it('dry run without EVAL_YES makes zero calls', async () => {
    const inner = vi.fn<typeof fetch>();
    const execute = vi.fn(callUpstream);
    const r = await runSuite(base({ env: { EVAL: '1' }, fetchImpl: inner, execute }));
    expect(r.status).toBe('dry-run');
    expect(r.estimate.calls).toBe(3);
    expect(execute).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('executes, records calls.jsonl and the ledger, and restores global fetch', async () => {
    const inner = vi.fn<typeof fetch>(async () => completion(0.01));
    const r = await runSuite(base({ env: LIVE, fetchImpl: inner, concurrency: 2 }));
    expect(r.status).toBe('complete');
    expect(inner).toHaveBeenCalledTimes(3);
    expect(r.spentUsd).toBeCloseTo(0.03);
    expect(new SpendLedger(path.join(dir, 'spend.jsonl')).spent()).toBeCloseTo(0.03);
    const lines = readLines(path.join(r.dir!, 'calls.jsonl'));
    expect(lines.map((l) => l.key).sort()).toEqual(['s|f0', 's|f1', 's|f2']);
    expect(lines[0]).toMatchObject({ status: 'ok', costSource: 'usage', calls: [{ provider: 'Makora' }] });
    expect(globalThis.fetch).toBe(throwingFetch);
  });

  it('prices from tokens, then from the estimate, when usage.cost is missing', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion(undefined))
      .mockResolvedValueOnce(new Response('{"choices":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const r = await runSuite(base({ env: LIVE, fetchImpl: inner, items: items(2) }));
    expect(r.lines.map((l) => l.costSource)).toEqual(['tokens', 'estimate']);
    expect(r.lines[0].costUsd).toBeCloseTo(callCost(MODEL, { promptTokens: 100, completionTokens: 20 }));
    expect(r.lines[1].costUsd).toBeCloseTo(callCost(MODEL, { promptTokens: 1000, completionTokens: 200 }));
  });

  it('resumes: skips completed keys and retries errored ones', async () => {
    let fail = true;
    const inner = vi.fn<typeof fetch>(async (_input, init) => {
      if (fail && init?.body === 's|f1') throw new Error('socket hang up');
      return completion(0.01);
    });
    const first = await runSuite(base({ env: LIVE, fetchImpl: inner }));
    expect(first.status).toBe('incomplete');
    expect(first.lines.find((l) => l.key === 's|f1')?.status).toBe('error');
    fail = false;
    inner.mockClear();
    const second = await runSuite(base({ env: LIVE, fetchImpl: inner }));
    expect(second.runId).toBe(first.runId);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('complete');
    // A finished run is not resumed: the same command now starts a new run.
    const third = await runSuite(base({ env: LIVE, fetchImpl: inner }));
    expect(third.runId).not.toBe(first.runId);
  });

  it('starts a new run when the config hash changes, or with EVAL_FRESH=1', async () => {
    const inner = vi.fn<typeof fetch>(async (_i, init) => {
      if (init?.body === 's|f2') throw new Error('boom');
      return completion(0);
    });
    const a = await runSuite(base({ env: LIVE, fetchImpl: inner }));
    const b = await runSuite(base({ env: LIVE, fetchImpl: inner, config: { v: 2 } }));
    const c = await runSuite(base({ env: { ...LIVE, EVAL_FRESH: '1' }, fetchImpl: inner }));
    const d = await runSuite(base({ env: { ...LIVE, EVAL_RUN: a.runId }, fetchImpl: inner }));
    expect(new Set([a.runId, b.runId, c.runId]).size).toBe(3);
    expect(d.runId).toBe(a.runId);
    await expect(runSuite(base({ env: { ...LIVE, EVAL_RUN: a.runId }, fetchImpl: inner, config: { v: 9 } }))).rejects.toThrow(
      /different suite or config/,
    );
  });

  it('refuses to start when ledger + estimate exceed the cap', async () => {
    new SpendLedger(path.join(dir, 'spend.jsonl')).record({ runId: 'old', key: 'k', usd: 0.5 });
    const inner = vi.fn<typeof fetch>();
    // 3 items estimate ~$0.00015; ledger $0.5 + that > $0.5001.
    const r = await runSuite(base({ env: { ...LIVE, EVAL_MAX_USD: '0.5001' }, fetchImpl: inner }));
    expect(r.status).toBe('refused-budget');
    expect(inner).not.toHaveBeenCalled();
  });

  it('aborts at the shared cap mid-run', async () => {
    const inner = vi.fn<typeof fetch>(async () => completion(0.6)); // actual cost far above the estimate
    const r = await runSuite(base({ env: { ...LIVE, EVAL_MAX_USD: '1' }, fetchImpl: inner, items: items(5) }));
    expect(r.status).toBe('aborted-budget');
    // After the first item the $0.60 average is reserved for the next one: 0.6 + 0.6 > 1.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(r.ledgerUsd).toBeCloseTo(0.6);
  });

  it('stops and throws if engine code swallows a refusal from the worker guard', async () => {
    // The runner's options say live, but the worker-wide guard (eval/setup.ts)
    // reads a non-live process env and refuses; the engine swallows the error.
    const inner = vi.fn<typeof fetch>();
    const execute = async () => {
      try {
        await fetch('https://openrouter.ai/api/v1/chat/completions');
      } catch {
        return { degraded: true }; // like swap() falling back
      }
    };
    const run = runSuite(base({ env: LIVE, fetchImpl: guardFetch(inner, {}), execute }));
    await expect(run).rejects.toBeInstanceOf(LiveCallRefused);
    expect(inner).not.toHaveBeenCalled();
  });

  it('treats a negative usage.cost as invalid and charges the estimate', async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: MODEL, usage: { cost: -5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const r = await runSuite(base({ env: LIVE, fetchImpl: inner, items: items(1) }));
    expect(r.lines[0].costSource).toBe('estimate');
    expect(r.lines[0].costUsd).toBeCloseTo(callCost(MODEL, { promptTokens: 1000, completionTokens: 200 }));
  });

  it('refuses to continue if the results directory vanishes mid-run', async () => {
    const inner = vi.fn<typeof fetch>(async () => {
      rmSync(dir, { recursive: true, force: true });
      return completion(0.01);
    });
    await expect(runSuite(base({ env: LIVE, fetchImpl: inner }))).rejects.toThrow(/vanished/);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('prices calls that errored or timed out without usage at the estimate', async () => {
    const inner = vi.fn<typeof fetch>(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    });
    const r = await runSuite(base({ env: LIVE, fetchImpl: inner, items: items(1) }));
    expect(r.lines[0]).toMatchObject({ status: 'error', costSource: 'estimate' });
    expect(r.lines[0].costUsd).toBeCloseTo(callCost(MODEL, { promptTokens: 1000, completionTokens: 200 }));
    expect(new SpendLedger(path.join(dir, 'spend.jsonl')).spent()).toBeCloseTo(r.lines[0].costUsd);
  });

  it('keeps the cap when spend.jsonl is deleted mid-run or between runs', async () => {
    const ledgerFile = path.join(dir, 'spend.jsonl');
    const inner = vi.fn<typeof fetch>(async () => {
      rmSync(ledgerFile, { force: true });
      return completion(0.4);
    });
    const r = await runSuite(base({ env: { ...LIVE, EVAL_MAX_USD: '1' }, fetchImpl: inner, items: items(5) }));
    expect(r.status).toBe('aborted-budget');
    expect(inner).toHaveBeenCalledTimes(2); // $0.80 spent; a third $0.40 item would pass $1
    rmSync(ledgerFile, { force: true });
    const again = await runSuite(base({ env: { ...LIVE, EVAL_MAX_USD: '0.8001', EVAL_FRESH: '1' }, fetchImpl: inner }));
    expect(again.status).toBe('refused-budget'); // floor from calls.jsonl: $0.80 + estimate > $0.8001
  });

  it('reserves in-flight items against the cap', async () => {
    const inner = vi.fn<typeof fetch>(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return completion(0.6);
    });
    const r = await runSuite(base({ env: { ...LIVE, EVAL_MAX_USD: '1' }, fetchImpl: inner, items: items(20), concurrency: 8 }));
    expect(r.status).toBe('aborted-budget');
    // 8 start at the (tiny) estimate; after that the $0.60 average is reserved, so nothing more starts.
    expect(inner).toHaveBeenCalledTimes(8);
    expect(r.ledgerUsd).toBeCloseTo(4.8);
  });

  it('stops when the upstream serves a different model than the plan priced', async () => {
    const inner = vi.fn<typeof fetch>(async () => completion(0.001, { model: `${MODEL}-20261101` })); // exact match only
    const r = await runSuite(base({ env: LIVE, fetchImpl: inner }));
    expect(r.status).toBe('aborted-model');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(r.lines[0].error).toMatch(/model mismatch/);
  });

  it('refuses a second runSuite in the same process', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = vi.fn<typeof fetch>(async () => {
      await gate;
      return completion(0);
    });
    const first = runSuite(base({ env: LIVE, fetchImpl: inner, items: items(1) }));
    await expect(runSuite(base({ env: LIVE, fetchImpl: inner, suite: 'other' }))).rejects.toThrow(/already running/);
    release();
    expect((await first).status).toBe('complete');
    expect(globalThis.fetch).toBe(throwingFetch);
  });

  it('rejects duplicate keys', async () => {
    await expect(runSuite(base({ env: LIVE, items: [...items(1), ...items(1)] }))).rejects.toThrow(/Duplicate/);
  });
});

describe('summary', () => {
  const s: Summary = {
    suite: 'baseline',
    runId: 'baseline-20261105-0100-abcd',
    date: '2026-11-05 01:00 UTC',
    status: 'complete',
    items: { total: 90, done: 89, errors: 1 },
    cost: { spentUsd: 0.0123, estimateUsd: 0.05, ledgerUsd: 0.4, capUsd: 2, pricesStale: true },
    tables: [{ title: 'Coverage', columns: ['Level', 'Median'], rows: [['L1', '31%'], ['L2', 'a|b']] }],
    notes: ['Gates are reported, not enforced.'],
  };

  it('renders a stable markdown summary', () => {
    expect(renderSummary(s)).toBe(
      [
        '# Eval summary: baseline',
        '',
        '- Run: `baseline-20261105-0100-abcd` (2026-11-05 01:00 UTC)',
        '- Status: complete',
        '- Items: 89/90 done, 1 errors',
        '- Spend: $0.01 this session (estimate $0.05, price table may be stale); eval ledger $0.40 of $2.00 cap',
        '',
        '## Coverage',
        '',
        '| Level | Median |',
        '|---|---|',
        '| L1 | 31% |',
        '| L2 | a\\|b |',
        '',
        '## Notes',
        '',
        '- Gates are reported, not enforced.',
        '',
      ].join('\n'),
    );
  });

  it('writes summary.md and summary.json', () => {
    const out = writeSummary(path.join(dir, 'r'), s);
    expect(readFileSync(out.md, 'utf8')).toBe(renderSummary(s));
    expect(JSON.parse(readFileSync(out.json, 'utf8'))).toEqual(s);
  });
});

describe('eval config', () => {
  it('extracts positional suite filters from vitest argv', () => {
    expect(suiteFilters(['run', '--config', 'eval/vitest.config.ts', 'baseline'])).toEqual(['baseline']);
    expect(suiteFilters(['run', '--config=eval/vitest.config.ts'])).toEqual([]);
    expect(suiteFilters(['run', '-c', 'x', 'a', 'b', '--silent'])).toEqual(['a', 'b']);
    expect(suiteFilters(['run', '--bail', '1', 'baseline'])).toEqual(['baseline']);
  });

  it('requires exactly one suite matching exactly one file', () => {
    const root = '/r';
    const suites = ['/r/eval/baseline.eval.ts', '/r/eval/latency.eval.ts', '/r/eval/baseline-judge.eval.ts'];
    expect(selectSuite(['baseline'], suites, root)).toBe('/r/eval/baseline.eval.ts');
    expect(selectSuite(['latency'], suites, root)).toBe('/r/eval/latency.eval.ts');
    expect(() => selectSuite([], suites, root)).toThrow(/exactly one suite/);
    expect(() => selectSuite(['baseline', 'latency'], suites, root)).toThrow(/exactly one suite/);
    expect(() => selectSuite(['eval'], suites, root)).toThrow(/matches 3/);
    expect(() => selectSuite(['x'], [], root)).toThrow(/\(none yet\)/);
  });

  const files = {
    EVAL: '1',
    EVAL_YES: '1',
    EVAL_MAX_USD: '9999',
    LLM_API_KEY: 'app-key',
    EVAL_LLM_API_KEY: 'eval-key',
    LLM_MODEL: 'anthropic/claude-opus-5',
    LLM_BASE_URL: 'https://pricey.example.com/v1',
    LLM_STRUCTURED_OUTPUTS: 'false',
  };

  it('ignores EVAL, EVAL_YES, EVAL_MAX_USD, model and base URL from .env files', () => {
    const env = buildEvalEnv(files, { OPENROUTER_API_KEY: 'old-app-key' });
    expect(env).toMatchObject({
      EVAL: '',
      EVAL_YES: '',
      EVAL_MAX_USD: '',
      EVAL_HARNESS: '1',
      LLM_API_KEY: '', // not live: no key at all, not even the eval key
      EVAL_LLM_API_KEY: '',
      OPENROUTER_API_KEY: '',
      LLM_MODEL: '',
      LLM_BASE_URL: '',
      LLM_STRUCTURED_OUTPUTS: 'false',
    });
    expect(env[APP_KEY_HASHES_VAR].split(',').sort()).toEqual([sha256('app-key'), sha256('old-app-key')].sort());
    expect(JSON.stringify(env)).not.toMatch(/app-key|eval-key/);
  });

  it('passes the eval key, cap, model and base URL only from a live shell', () => {
    const env = buildEvalEnv(files, {
      EVAL: '1',
      EVAL_YES: '1',
      EVAL_MAX_USD: '1',
      EVAL_LLM_MODEL: 'google/gemma-4-26b-a4b-it',
      LLM_API_KEY: 'shell-app-key',
    });
    expect(env).toMatchObject({ EVAL: '1', EVAL_YES: '1', EVAL_MAX_USD: '1', LLM_API_KEY: 'eval-key', LLM_MODEL: 'google/gemma-4-26b-a4b-it', LLM_BASE_URL: '' });
    expect(env[APP_KEY_HASHES_VAR].split(',')).toContain(sha256('shell-app-key'));
    expect(evalModel(env)).toBe('google/gemma-4-26b-a4b-it');
    expect(evalModel(buildEvalEnv(files, {}))).toBe(MODEL);
  });
});

describe('eval key must differ from the app key', () => {
  it('throws when EVAL_LLM_API_KEY equals an app key', () => {
    expect(() => buildEvalEnv({ LLM_API_KEY: 'same', EVAL_LLM_API_KEY: 'same' }, {})).toThrow(/separate/);
    expect(() => buildEvalEnv({ EVAL_LLM_API_KEY: 'same' }, { OPENROUTER_API_KEY: 'same' })).toThrow(/separate/);
  });
});

describe('app keys are unusable (direct swap() calls)', () => {
  const TEXT = 'The dog runs home. The cat sleeps all day.';
  const files = { LLM_API_KEY: 'app-key', OPENROUTER_API_KEY: 'app-key-2', EVAL_LLM_API_KEY: 'eval-key' };

  function applyEnv(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const bearers = (inner: ReturnType<typeof vi.fn<typeof fetch>>) =>
    inner.mock.calls.map((c) => new Headers(c[1]?.headers).get('authorization'));

  it('eval worker, dry-run shell: swap() sends nothing', async () => {
    applyEnv(buildEvalEnv(files, {}));
    const inner = vi.fn<typeof fetch>(async () => completion(0));
    globalThis.fetch = guardFetch(inner); // what eval/setup.ts installs; restored by installThrowingFetch
    const result = await swap(TEXT, 1);
    expect(result.degraded).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it('eval worker, live shell with an app key exported: swap() uses only the eval key', async () => {
    applyEnv(buildEvalEnv(files, { EVAL: '1', EVAL_YES: '1', LLM_API_KEY: 'shell-app-key' }));
    const inner = vi.fn<typeof fetch>(async () => completion(0));
    globalThis.fetch = guardFetch(inner);
    await swap(TEXT, 1);
    expect(inner).toHaveBeenCalled();
    expect(new Set(bearers(inner))).toEqual(new Set(['Bearer eval-key']));
  });

  it('eval worker, live shell: a request carrying an app key is refused', async () => {
    applyEnv(buildEvalEnv(files, { EVAL: '1', EVAL_YES: '1' }));
    vi.stubEnv('LLM_API_KEY', 'app-key'); // e.g. code that re-reads .env.local itself
    const inner = vi.fn<typeof fetch>(async () => completion(0));
    globalThis.fetch = guardFetch(inner);
    const result = await swap(TEXT, 1);
    expect(result.degraded).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it('root run, live-looking shell with the app key: the harness stays a dry run', async () => {
    applyEnv({ EVAL: '1', EVAL_YES: '1', LLM_API_KEY: 'app-key' }); // no EVAL_HARNESS
    const inner = vi.fn<typeof fetch>(async () => completion(0));
    const execute = vi.fn(async () => swap(TEXT, 1));
    const r = await runSuite({ suite: 's', config: {}, items: items(1), execute, resultsDir: dir, log: () => {}, fetchImpl: inner });
    expect(r.status).toBe('dry-run');
    expect(execute).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('root run: a direct swap() in an eval unit test hits the throwing fetch', async () => {
    applyEnv({ LLM_API_KEY: 'app-key' });
    const result = await swap(TEXT, 1);
    expect(result.degraded).toBe(true); // nothing left the process: the global fetch throws
  });
});

describe('results dir layout', () => {
  it('is gitignored', () => {
    const gitignore = readFileSync(path.resolve(import.meta.dirname, '../../.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\/eval\/results\/$/m);
  });
});
