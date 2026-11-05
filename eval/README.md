# Evals

Live evaluation suites for the swap engine, plus the fixtures and harness they share.
This PR adds the fixtures and the harness only. The suites (`*.eval.ts`: baseline, judge, latency)
come in later PRs.

## Layout

- `fixtures/`: 20 original texts (10 English, 10 Spanish). The genres are news, email, social
  posts and recipes. Names, places and URLs are made up. `manifest.json` lists each text's id,
  language, genre, target word count and `nativeChecked`. Protected tokens (names, numbers,
  dates and times, URLs and emails, @handles and #tags) are marked `⟦…⟧`. Two fixtures need a
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
   Evals use only `EVAL_LLM_API_KEY`. They blank `LLM_API_KEY` and `OPENROUTER_API_KEY`, so the
   app key is never spent.

## Running a suite

Every live suite is a dry run unless both flags are set **in the shell**. The flags are ignored
if they appear in `.env` files.

```
EVAL=1 npm run eval -- <suite>              # plan + estimated cost, no calls
EVAL=1 EVAL_YES=1 npm run eval -- <suite>   # run it
```

- You must name exactly one suite. Suites run one at a time.
- **Spend cap:** `EVAL_MAX_USD` defaults to `2`. It is checked against a shared ledger,
  `eval/results/spend.jsonl`, that covers every run and suite.
  - A run won't start if ledger + estimate would exceed the cap.
  - A run stops scheduling calls once the ledger reaches the cap.
  - To allow more, raise `EVAL_MAX_USD` or move `spend.jsonl` aside.
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
