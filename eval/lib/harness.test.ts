import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callCost, estimateCost, estimateTokens } from './cost';
import { buildEvalEnv, selectSuite, suiteFilters } from './evalConfig';
import { LiveCallRefused, assertLiveCallsAllowed, liveCallsAllowed } from './guard';
import { SpendLedger, readCap } from './ledger';
import { createRecorder, readResponseFields } from './record';
import { readLines, runSuite, type PlanItem } from './run';
import { renderSummary, writeSummary, type Summary } from './summary';
import { installThrowingFetch, throwingFetch } from './testing';

installThrowingFetch();

const LIVE = { EVAL: '1', EVAL_YES: '1' };
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
    [{ EVAL: 'true', EVAL_YES: '1' }, false],
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
    expect(inner).toHaveBeenCalledTimes(2);
    expect(r.ledgerUsd).toBeCloseTo(1.2);
  });

  it('stops and throws if engine code swallows a refused call', async () => {
    const execute = async () => {
      await new Promise((r) => setTimeout(r, 0)); // let the test flip EVAL_YES first
      try {
        await fetch('https://openrouter.ai/api/v1/chat/completions');
      } catch {
        return { degraded: true }; // like swap() falling back
      }
    };
    // Force the runner past its own dry-run check, while the recorder still sees no EVAL_YES.
    const env: Record<string, string> = { ...LIVE };
    const inner = vi.fn<typeof fetch>(async () => {
      throw new Error('unreachable');
    });
    const run = runSuite(base({ env, fetchImpl: inner, execute }));
    env.EVAL_YES = '0';
    await expect(run).rejects.toBeInstanceOf(LiveCallRefused);
    expect(inner).not.toHaveBeenCalled();
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

  it('takes EVAL flags from the shell only and uses the separate eval key', () => {
    const env = buildEvalEnv(
      { EVAL: '1', EVAL_YES: '1', LLM_API_KEY: 'app-key', EVAL_LLM_API_KEY: 'eval-key', LLM_MODEL: 'm' },
      { OPENROUTER_API_KEY: 'old-app-key', EVAL_MAX_USD: '1' },
    );
    expect(env.EVAL).toBe('');
    expect(env.EVAL_YES).toBe('');
    expect(env.LLM_API_KEY).toBe('eval-key');
    expect(env.OPENROUTER_API_KEY).toBe('');
    expect(env.LLM_MODEL).toBe('m');
    expect(env.EVAL_MAX_USD).toBe('1');
    expect(buildEvalEnv({ LLM_API_KEY: 'app-key' }, { EVAL: '1', EVAL_YES: '1' })).toMatchObject({
      EVAL: '1',
      EVAL_YES: '1',
      LLM_API_KEY: '',
    });
  });
});

describe('results dir layout', () => {
  it('is gitignored', () => {
    const gitignore = readFileSync(path.resolve(import.meta.dirname, '../../.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\/eval\/results\/$/m);
  });
});
