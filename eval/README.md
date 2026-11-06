# Evals

Live evaluation suites for the swap engine, plus the fixtures and harness they share.
This PR adds the fixtures and the harness only. The suites (`*.eval.ts`: baseline, judge, latency)
come in later PRs.

## Layout

- `fixtures/`: 20 original texts (10 English, 10 Spanish). The genres are news, email, social
  posts and recipes. Names, places and URLs are made up. `manifest.json` lists each text's id,
  language, genre, target word count and `nativeChecked`. Protected tokens are marked `⟦…⟧`:
  names, numerals, URLs, emails, @handles and #tags. Weekdays, months, a.m./p.m., currency
  symbols and units are deliberately left unmarked in both languages, and the lint test
  enforces that. Two fixtures need a
  note:
  - `*-news-1` is the ~1,000-word text for the latency suite.
  - `*-torture` deliberately packs in hard cases: abbreviations, numbers, times, URLs, clitics,
    contractions, NBSP, NFD accents. It isn't natural prose.
- `lib/fixtures.ts`: the loader. It strips the markers and returns the exact protected offsets.
  It also gives each text's first sentence and first five words, for language detection.
- `lib/run.ts`: the runner. It shows the plan and estimated cost, does a dry run unless you
  confirm, resumes interrupted runs and enforces the spend cap.
- `lib/record.ts`: records each upstream call: time, status, `usage`, provider and generation id.
- `lib/summary.ts`: writes `summary.md` and `summary.json`.
- `results/`: run output. It's gitignored.

`npx vitest run` runs the harness and fixture unit tests. It never runs `*.eval.ts`. The unit
tests replace `fetch` with one that throws, so they can't reach a real API.

## One-time setup

1. Create a **separate OpenRouter key just for evals**, with a lifetime credit limit (e.g. $3)
   and no daily reset. Don't reuse the production key. A daily cap hit in the middle of an eval
   would block the app for the rest of the day.
2. Put it in `.env.local` (or `.env.eval.local`) at the repo root:
   ```
   EVAL_LLM_API_KEY=sk-or-...
   ```
   - Evals use only `EVAL_LLM_API_KEY`, and only when the shell has `EVAL=1 EVAL_YES=1`.
   - The app keys (`LLM_API_KEY`, `OPENROUTER_API_KEY`) are blanked in eval workers.
   - Any request that carries an app key is refused.
3. You need Node 20.12 or newer. The env files are read with `util.parseEnv`, which doesn't
   expand `${VAR}`.

## Running a suite

Every live suite is a dry run unless both flags are set **in the shell**. The flags are ignored
if they appear in `.env` files.

Every `fetch` in an eval worker is guarded, not only the calls a suite makes through the
runner. Live calls also require the `EVAL_HARNESS=1` marker, which only `eval/vitest.config.ts`
sets. So a root `npx vitest run` can never go live, whatever the shell says.

Only the shell can change spend settings. These are ignored in `.env` files:
- `EVAL_MAX_USD`;
- `EVAL_LLM_MODEL` and `EVAL_LLM_BASE_URL`, which default to the engine's defaults. The app's
  `LLM_MODEL` and `LLM_BASE_URL` are ignored.

```
EVAL=1 npm run eval -- <suite>              # plan + estimated cost, no calls
EVAL=1 EVAL_YES=1 npm run eval -- <suite>   # run it
```

- You must name exactly one suite. Suites run one at a time.
- **Spend cap:** `EVAL_MAX_USD` defaults to `2`. It is checked against a shared ledger,
  `eval/results/spend.jsonl`, that covers every run and suite.
  - A run won't start if spend + estimate would exceed the cap.
  - Before each item, that item and every item in flight are reserved against the cap. Each one
    is reserved at its estimate or the run's average actual cost, whichever is higher.
  - Calls that time out or fail without reporting usage are charged at their estimate.
  - Spend is the larger of `spend.jsonl` and the costs recorded in every `calls.jsonl`, so
    deleting `spend.jsonl` doesn't reset it.
  - To allow more, raise `EVAL_MAX_USD`.
  - If `results/` disappears mid-run, the run stops.
  - Known limit (to fix in B2b): until the first item finishes, items are reserved at their
    estimate. If the estimate is far too low, the first concurrent batch can overshoot the cap
    by up to `concurrency` × the real per-item cost. Keep concurrency low until the estimates
    are checked against real runs.
- **Separate key:** a run refuses to start if `EVAL_LLM_API_KEY` equals an app key.
- **Model check:** a run stops if OpenRouter serves a different model than the plan priced (exact slug match).
- **One run per process:** suites call `runSuite` one at a time.
- **Resume:** re-running the same command continues the newest unfinished run with the same
  config. Finished items are skipped and failed ones are retried.
  - `EVAL_RUN=<runId>` picks a specific run.
  - `EVAL_FRESH=1` starts a new one.
- **Output:** `eval/results/<runId>/` gets `calls.jsonl`, `run.json`, `summary.md` and
  `summary.json`. Paste `summary.md` back to the team.

## Cost

Estimates use a hard-coded price table in `lib/cost.ts`. Check current prices before a large
run. Actual spend comes from each response's `usage.cost`.

Using Gemma 4 26B at $0.032 / $0.097 per M tokens:
- a 90-call baseline costs about two cents;
- the planned suites together are expected to cost well under $1.
