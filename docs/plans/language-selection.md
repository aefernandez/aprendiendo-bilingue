# Plan: target-language selection with automatic source detection

*Nov 2026 · Drafted by an architect and a detection researcher, then attacked by three adversarial reviewers (technical, product/spec, cost/ops), with a second technical review of the redesigned span format. What changed because of each review is logged at the end.*

## The short answer

**Auto-detecting the source language is not meaningfully harder than asking for it.** Detection costs about one day of work either way.

For each target, only a few sources are valid:

| Target | Valid sources |
|---|---|
| English | Spanish |
| Italian | Spanish or English |

So the detector makes a constrained choice, and almost always it's just Spanish vs English. A small JS library (eld) got that call right 27 times out of 28 on hard samples, in about 0.01 ms. The user picks only the target, and can always override the detected source with one tap.

**What *is* expensive is unrelated to detection.** Two of the three launch pairs have a Spanish source, and today's span selector (compromise) only understands English. Supporting Spanish means moving span selection into the LLM. You pay that cost whether you detect or select.

So the plan has two milestones:

| Milestone | What you get | Size |
|---|---|---|
| **A. Language selection** | Target picker, source detection shown *before* you submit, registry-driven copy and `lang` attributes. Works end to end for English→Italian. Spanish text is recognised and labelled "coming soon" instead of producing garbage. | 3 PRs, ~600 lines, ~3–4 days |
| **B. Multilingual engine** | LLM span selection, so Spanish→English and Spanish→Italian actually work. Includes abuse protection and an eval that gates turning them on. | 5 PRs, ~1,000 lines plus fixtures, ~1.5–2 weeks |

The alternative, "select both languages", saves only the detection PR (~200 lines). Milestone B is unchanged in either case.

Enabling the Spanish pairs before the learning list and SRS moves "all three pairs" forward from spec Phase 2 to now. That's deliberate, because it's what was asked for. The rest of Phase 2 is unchanged.

---

## Milestone A — Language selection

### A1. Language registry (`lib/languages.ts`, data only, safe on client and server)

```ts
export const LANGUAGES = {
  en: { code: 'en', name: 'English', endonym: 'English', locale: 'en' },
  es: { code: 'es', name: 'Spanish', endonym: 'Español', locale: 'es' },
  it: { code: 'it', name: 'Italian', endonym: 'Italiano', locale: 'it' },
} as const satisfies Record<string, Language>;

export const PAIRS: Pair[] = [
  { source: 'es', target: 'en', promptNotes: '…' },
  { source: 'en', target: 'it' },
  { source: 'es', target: 'it', promptNotes: 'Keep Spanish contractions (del, al) and clitics (dámelo) as written.' },
];
```

- **Which pairs are live** comes from an `ENABLED_PAIRS` env var (default `en-it`). It doubles as a kill switch per pair, with no code change. Changing it needs a redeploy; see Operations below.
- **Helpers:** `targets()`, `sourcesFor(target)`, `isEnabledPair()`.
- **Adding a pair** means adding a data entry. Adding a language also needs a `LANGUAGES` entry, its eld code, and later `data/freq/<code>.json`.
- **Registry tests:** every pair uses known codes; every locale constructs `Intl.Segmenter` and `Intl.DisplayNames`; every source language is one eld recognises.

### A2. Source detection (`lib/sourceLanguage.ts`, starts with `import 'server-only'`)

#### Library: eld 2.1.0

| Detector | Accuracy (44 hard samples) | Notes |
|---|---|---|
| franc-min | 23/44 | Returned Tagalog, Hausa, Romanian on short text |
| tinyld | 40/44 | Last published Jan 2024 |
| **eld 2.1.0, extrasmall model** | **41/44**; 27/28 on the Spanish-vs-English decision | Apache-2.0, maintained |

Packaging rules for eld:
- Import only `eld/extrasmall`, lazily, with the module promise cached. The default entry loads data files by computed path, and a bundler may then pull in all 8.6 MB of models.
- Keep it server-only. The extrasmall data is 954 KB raw / 279 KB gzipped.
- Cold import is about 170 ms and about 36 MB of heap.
- Check `node_modules/next/dist/docs/` to see whether it needs `serverExternalPackages` (AGENTS.md says this Next version differs from what we expect).

#### `resolveSource({ text, target, explicit?, hint? })`

**Step 1 — Detect.** Run one *unrestricted* eld call on every path, including explicit and inferred ones.
- eld only reads the first 1,000 characters, so score three windows (start, middle, end) and take the majority.
- Never call `setLanguageSubset`. It sets instance-global state that concurrent requests would race on, and picking the best allowed language from the full scores gives the same result.
- If only one language scores, the margin is 0.

**Step 2 — Short or uncertain text.** If the text is under ~20 characters, or the top-two margin is below `DETECT_MARGIN` (start at 0.05, tune with the eval), skip the blocking checks:
- Use `explicit`, else `hint` if it's valid for the target, else `sourcesFor(target)[0]`.
- Return `method: 'fallback'`. This shows as a question ("Español?"), not as a confident detection.

**Step 3 — Blocking checks** (only when confident). Each returns 422 `{ error, code, detectedLang }`, and no LLM call is made:

| Code | When | Message |
|---|---|---|
| `unsupported_source` | Top language isn't in the registry and leads the best supported language by its own threshold | "We can't mix Portuguese yet." |
| `same_as_target` | Top language is the target | "This already looks like Italian." |
| `pair_not_enabled` | Spanish text while only en→it is live | "Spanish → Italian is coming soon." |

The `unsupported_source` threshold is tuned separately because Catalan sits only 0.05 behind Spanish.

**Step 4 — Choose the source.**
- If `explicit` is set → `method: 'selected'`. If it contradicts a confident detection, add a diagnostics warning but don't block.
- Else if only one source is valid → `method: 'inferred'`.
- Else take the best allowed language → `method: 'detected'`.

**If eld fails to load:** log it and fall back to `explicit` / `hint` / default with `method: 'fallback'`. Never a 500.

#### `POST /api/detect { text, target }`

Returns the same resolution without any LLM call. The client calls it debounced (~400 ms after paste or typing stops), so the user sees and can correct the source **before** submitting. The 422 cases surface here too, before any wait.

It is rate-limited like `/api/swap` (see B1).

### A3. API contract

**Request:** `{ text, level, targetLang?, sourceLang?, sourceHint? }`
- A legacy `{ text, level }` request still works: target Italian, detection on.
- `sourceLang` is an explicit override.
- `sourceHint` must be a registry code, or it is ignored.

**Response:** today's `SwapResult` plus:
- `sourceLang` and `targetLang`, always the resolved values.
- `source: { method, margin? }`

**Contract for later phases:** F5 saved words and F6 history must store `sourceLang` and `targetLang` from this response. That's why the response always carries them.

### A4. UI

**Picker.** A full-width segmented control above the textarea, labelled **"Learning:"**, with options English | Italiano (endonyms).
- It's a `role="radiogroup"` with `aria-checked`, `lang` on each endonym, and touch targets of at least 44 px.
- It stays above the fold with the mobile keyboard open.
- A target with no enabled pair shows "coming soon" and is disabled.
- The level buttons get `aria-pressed` in the same pass.

**Source chip.** Shown under the textarea once `/api/detect` answers:

| Result | Chip |
|---|---|
| `detected` | "Detected: Español ▾" |
| `inferred` or `selected` | "Español ▾" |
| `fallback` | "Español? ▾" |

- Tapping the chip lists the valid sources. Choosing one sets `sourceLang`.
- A 422 replaces the chip with its message and a one-tap fix: switch target, or choose the source.

**Persistence:** `localStorage['ab.pair.v1'] = { target, lastSourceByTarget }`, read with `useSyncExternalStore` to avoid a hydration mismatch.
- The last source per target is sent as `sourceHint`.
- An override is remembered as the hint for the next text but is not forced on it; detection still runs fresh.

**Defaults:**
- First visit: target English if `navigator.language` starts with `es`, otherwise Italian.
- The picker is visually prompted until the user taps it once.

**Behaviour when things change:**
- Pasted text is kept when the target changes.
- "New text" keeps the target and level.
- The reader header ("Español → Italiano") is display-only.

**Copy:**
- All copy comes from the registry: "How much {target} do you want?" (spec F2), "~30% {target}", "Paste {sources joined with 'or'} text…", "Tap any {target} word…".
- The tagline becomes the spec's "Read anything in your target language, starting today." (in `page.tsx` and in the `layout.tsx` metadata).
- **Chrome language:** ship a small string table of ~15 strings keyed by the detected or last source (`es`/`en`), and set `<html lang>` to match. Spanish speakers learning English shouldn't need English to use the app. *Owner decision: keep this, or defer it.*

**`lang` attributes** (fixes review item M7):
- Reader `<p lang={sourceLocale}>`.
- Each target span gets `lang={targetLocale}`.
- `expandToWords(segments, targetLocale)` uses a per-locale `Intl.Segmenter` cache instead of the hard-coded `'it'`.

**Definition card (spec F4):**
- Shows the target phrase, the back-translation and the part of speech (from B3).
- Labels its languages ("Italiano → Español") and carries `lang` on both lines.

### A5. Diagnostics

Server events:
- `Source es (detected, margin 0.21; es .61 / ca .56 / en .12)`
- `Source en (fallback: text too short; hint)`
- `422 pair_not_enabled (es→it)`

The 422 responses include `debug`. The client logs picker and chip changes.

---

## Milestone B — Multilingual engine

### Decision: the LLM chooses spans, by word index

The text is split into words on the server. The model sees them numbered and returns ranges, so it never has to copy source text.

```
Input:  [0]Juan [1]come [2]pan [3]y [4]bebe [5]agua. [6]Luego [7]come [8]fruta.
Output: {"i":[[1,2,"come","mangia il pane","v"],[7,8,"come","mangia frutta","v"]]}
```

Each item is `[startWord, endWord, anchor, translation, posCode]`:
- Ranges are **inclusive**, and indices are **local to each chunk**, restarting at 0. The prompt states both and gives one worked example.
- `anchor` is the first source word of the range, copied by the model. It costs about 2 tokens per item and makes mis-numbering detectable on every call (see validation below).

**Why indices instead of the earlier "model echoes the source substring" design.** The technical review prototyped the substring aligner and broke it repeatedly:

| What broke | Example |
|---|---|
| NFC normalization shifted offsets | Wrong characters cut from the original text |
| The cursor matched a later repeat of a word | "come" aligned to the second occurrence; nothing reported |
| Copy variants dropped the item | Curly vs straight apostrophes, non-breaking spaces, sentence-initial capitals |
| An apostrophe split a word | "don" + "t know" |

The case for indices is **correctness, not tokens**. A follow-up review counted tokens on a 1,040-word Spanish text with 278 items (o200k tokenizer; Gemma's may differ):

| Format | Output tokens |
|---|---|
| Substring, object keys (first draft) | 6,097 |
| Index format | 4,226 |
| Substring, compact arrays | 3,869 |
| Translations alone | 1,998 |

Indices cost about the same as compact substring arrays. Input grows about 4× (about 1.2K → 4.8K tokens) because of the numbering, which costs some prefill time but little money.

With indices:
- Offsets come from our own tokenizer, so they are exact by construction.
- **Anchor check.** The anchor must match the token at `startWord`, case-insensitively. On a mismatch, look for it at ±1 and ±2 and shift the range; otherwise drop the item. The mismatch rate is logged on every call and gated in B2.
- Validation becomes simple integer checks:
  - ranges in bounds, ascending, and not overlapping;
  - a range must not cross a sentence boundary, using the chunker's corrected boundaries (so "EE. UU." and "Sr. García" stay legal);
  - the translation must be non-empty, contain no newline or URL, and be at most 4× the source length + 20 characters (this also caps prompt-injection output);
  - if the translation equals the source (a cognate such as *hotel*), keep it as "not swapped", not as an error.

**Risk:** the model may mis-number. The likely errors are off-by-one (the `[n]` sits right after the previous word's punctuation), treating `endWord` as exclusive, and drift late in long chunks.
- Without the anchor, an index error would be a silent wrong-but-valid swap. With it, most errors are caught and repaired or dropped at runtime, and counted.
- The eval's judge sample remains as a secondary check for errors the anchor can't see (a correct start with a wrong end).
- If the anchor-mismatch rate exceeds the B2 gate, fall back to the substring design with the review's fixes:
  - map quotes and NBSP one-for-one on both sides;
  - search for each item within its own sentence;
  - case-insensitive fallback match;
  - treat an apostrophe between letters as part of the word.

**Word tokenizer:**
- `Intl.Segmenter(sourceLocale, { granularity: 'word' })`, with an apostrophe between letters kept inside the word, and letter-hyphen-letter merged into one token (well-known, e-mail, post-COVID).
- URLs and email addresses are masked before tokenizing, so they get no index. Unmasked, a single URL became 6 indexed tokens.
- Only word-like tokens get indices; punctuation and spaces sit between them. Emoji, `¿`/`¡` and quotes stay outside tokens and pass through untouched.
- Today's exclusions (names, numbers) move into the prompt rule.
- A token is **numeric** if it contains a digit and no letter (3,5 · 1.000 · 10:30). Numeric tokens are never valid range ends. Note that Intl.Segmenter keeps `2º`, `3años` and `30h` as single tokens; test them explicitly.

**Not part of this design:** `lib/tagger.ts` (compromise) stays only behind `SWAP_SPANS=tagger` for en→it during rollout, then is deleted.

### Latency: everything in parallel, small chunks

The cost review re-derived the numbers. At level 3, the earlier design needed about 6–7K output tokens per 1,000 words, against the 3–3.5K estimated. One 1,200-character chunk took 13–45 s depending on which provider served it. That can't fit 15 s.

Changes:

- **Fewer output tokens.**
  - Compact arrays with one-letter POS codes: about 8–10 tokens of overhead per item on top of the translation.
  - Level 3 on 1,000 words is about 250–280 items, roughly 3.5–4.2K output tokens in total, or about 300–350 per chunk across 12 chunks. This only fits 15 s if each chunk runs in parallel on a provider near 110 tok/s, which is why B2 measures it first.
  - `max_tokens` is sized per chunk.
  - A cut-off reply is salvaged up to its last complete item.
- **Chunks.**
  - Greedy packing of paragraphs and sentences.
  - Target size depends on level: about 1,000 characters at level 1 and about 500 at level 3.
  - A sentence longer than the target is hard-split at a word boundary.
  - `Intl.Segmenter` sentence breaks after abbreviations (Sr., EE. UU., Mr.) are rejected when the token before the break is shorter than 4 characters.
  - `MAX_CHUNKS = 12`. Smaller chunks are merged to stay under it.
- **Parallelism.** All chunks are sent at once; there are no waves.
- **Context.** Each chunk prompt includes the neighbouring sentence as read-only context, to keep gender and tense agreement across chunk boundaries.
- **Provider routing.** OpenRouter `provider: { sort: 'throughput', require_parameters: true, max_price }`. By default OpenRouter favours the cheapest provider, which for this model is also the slowest at about 31 tok/s.
- **Retries.**
  - Never retry a 429; honour `Retry-After`.
  - At most 2 chunk retries per request, and only if more than 4 s remain.
  - If more than half the chunks fail, stop early and return degraded.
- **Expected result:** about 300–400 output tokens per chunk at about 110 tok/s, so 3–5 s per chunk with all chunks in parallel, plus prefill for the larger numbered input. B2 confirms this before B3 is built.

**`partial` vs `degraded`:**
- Some chunks fell back to source text → `partial: true`, and the reader shows a quiet notice.
- All chunks failed → `degraded: true`.

### Calibration (~30/60/90%)

- The prompt carries the spec's level rubrics plus "aim for about N% of words".
- The server measures **coverage**: the share of word tokens inside swapped ranges. It's logged and scored in the eval.
- A deterministic trim to the level's band is a follow-up, built only if the eval shows drift.

### Engine interface (`lib/swapEngine.ts`, still one module)

```ts
export interface SwapInput { text: string; sourceLang: LangCode; targetLang: LangCode; level: Level; userWords?: string[] }
export interface SwapEngine { swap(input: SwapInput, opts?: SwapOptions): Promise<SwapResult> }
```

- Detection happens before the engine is called. The engine always receives a resolved source.
- Prompts come from `buildPrompts(pair, level, chunk, context)`, a single template filled from the registry plus `promptNotes`.
- `reconstructSegments` is unchanged. `Segment` gains `pos?`.
- Milestone A ships the interface with the current tagger behind it, so B swaps the implementation without touching the route or UI.

### Abuse protection and operations

The new design makes up to 12 upstream calls per request instead of 1–2, on a public, unauthenticated endpoint. The cost review estimated:

| Case | Cost |
|---|---|
| Worst-case request | about $0.004–0.02 |
| One abusive client at 1 request/s | about $350–1,600/day |

So protection is required before B3's default flips, not a risk to note:

- **Limits** on both `/api/swap` and `/api/detect`:
  - a per-IP rate limit;
  - a global daily spend cap, counted from OpenRouter's `usage` field, kept in Vercel KV or Edge Config;
  - a spend limit on the OpenRouter key itself.
- **Monitoring:** one structured log line per request (pair, source method, chunks, partial/degraded, coverage, ms, tokens, provider), plus an alert on the degraded+partial rate and on daily spend.
- **Debug console:**
  - Make it opt-in (`NEXT_PUBLIC_DEBUG_CONSOLE === 'true'`) so production doesn't publicly show model, provider and timing details.
  - Server logs keep counts only, never user text.
  - *This changes the default set yesterday. Owner decision.*
- **Rollback:**
  - `ENABLED_PAIRS` turns a pair off with one env change plus a redeploy, or use Vercel Instant Rollback.
  - The tagger is deleted only after a week of clean live metrics.

### Testing

**Unit tests (CI)**

| Test | What it covers |
|---|---|
| Tokenizer | Apostrophes (don't, O'Brien, rock'n'roll, plural possessive dogs'), hyphens (well-known, e-mail), clitics (dámelo), del/al, accents NFC and NFD, curly quotes, emoji, `¿`/`¡`, numbers (3,5 · 1.000 · 10:30h · 2º · 3años), URLs and emails masked |
| Anchor check | Exact match, off-by-one repaired, ±2 repaired, no match dropped, exclusive-end mistake |
| Chunker | Abbreviations, a 3,200-character run with no punctuation, `MAX_CHUNKS`, offsets round-trip |
| Item validator | Out-of-range, overlapping and sentence-crossing ranges, cognates, oversized or URL translations |
| `sourceLanguage` (real eld, which is fast and deterministic) | Each path in A2; Catalan, Portuguese, Galician and French negatives; English-quote-first Spanish article (three-window vote); single-score margin; failed eld import; concurrent calls for different targets |
| Engine (fetch mocked) | Mocked runs for all three pairs; partial and degraded; retry budget; no retry on 429; prompt snapshot per pair |
| Route | 422 shapes; legacy request |

**Golden eval** (`eval/`, separate vitest config, `EVAL=1 npx vitest run eval/`, not in CI)

*Fixtures.* 20 texts, 10 English and 10 Spanish: news, email, social post, recipe. Each has its names and numbers annotated, plus first-sentence and first-five-word variants for detection.

*Runs.* Each fixture × applicable pair × level, repeated 3 times: about 270 swap calls, under $1. The provider that served each call is recorded.

*Latency* is measured separately: sequentially, against a deployed preview, so cold starts and network time count.

**Scores and gates per pair** (gates are stated as counts; 90 runs per pair):

| Score | Gate |
|---|---|
| Runs not degraded and not partial (`partial` counts as a failure here) | ≤ 2 failures |
| Coverage median per level | Inside the band (L1 15–45%, L2 45–75%, L3 75–95%) |
| Names and numbers preserved | No misses |
| Wrong pairing, judged by a stronger model on a 30-item sample (required, not optional) | ≤ 1 |
| Latency p95, 1,000-word level-3 fixture, 20 sequential runs on the preview | < 12 s |
| Detection | No confident wrong answer on full texts or first sentences; fallback is allowed. All negatives blocked. |

Also reported: drop rate, cognate rate, translation-length ratio, output tokens, cost per call, and run-to-run variance.

---

## Rollout

Every PR branches from fresh `origin/main` and targets `main`. Check with `gh pr view --json baseRefName` before merging. A PR that needs another is cut only after that one merges. Last time, stacked PRs merged into each other's branches and production missed three fixes.

| # | PR | Size | Accept when |
|---|---|---|---|
| **A1** | Registry, `SwapEngine` interface around the current tagger, new optional request fields, locale segmenter, `lang` attributes, registry-driven copy, F4 card labels | ~250 lines | Existing tests pass; a legacy request behaves the same; target spans have `lang="it"` |
| **A2** | eld detection, `/api/detect`, 422 checks on every path, `ENABLED_PAIRS`, rate limit on both routes | ~250 lines | Detection unit tests pass; eld absent from the client bundle (check the build output); cold request +<250 ms; Spanish input gets "coming soon" before any LLM call |
| **A3** | Picker, pre-submit source chip, persistence, localized chrome (if kept), a11y fixes | ~250 lines | Target survives a reload; override works; 422 UIs work; mobile QA with the keyboard open |
| **B1** | Spend cap, `usage` logging, structured log line, debug console opt-in | ~150 lines | Spend cap blocks when over; alert fires in a test |
| **B2** | Eval harness, fixtures, tagger baseline, plus a spike comparing index (with anchor) vs compact-substring format on two providers, across all fixtures, not a single chunk | ~350 lines + fixtures | Baseline and spike numbers committed back into this plan; anchor-mismatch rate ≤ 2% before repair, or switch to the substring format; single-chunk p95 measured |
| **B3** | Tokenizer, chunker, index-format engine, validator, parallel calls, retry budget, provider routing, `pos` (behind `SWAP_SPANS`) | ~450 lines | Unit tests pass; eval gates pass for all three pairs (Spanish pairs enabled in the eval only) |
| **B4** | Flip `SWAP_SPANS=llm`, add `es-en,es-it` to `ENABLED_PAIRS`, show `pos` on the definition card | Config + ~50 lines | Mobile QA on all three pairs; live degraded+partial rate < 3% for a week |
| **B5** | Delete compromise and `tagger.ts` | Deletion | After B4's week is clean |

A1 and B2 can be built in parallel. B1 can merge any time before B4.

**Later:**
- Frequency tiers in the prompt (`data/freq/*.json`).
- Coverage trim, if the eval shows drift.
- An LLM `detectedSource` cross-check, logged only.

## Open decisions for the owner

1. **Localized chrome** (Spanish UI strings for Spanish-source users) in A3, or defer?
2. **Debug console default:** switch to opt-in now that it will show more (B1)?
3. **Spanish pairs before SRS:** confirm pulling "all three pairs" forward from Phase 2.

## Risks still open

- **Index mis-numbering by the model.** Caught at runtime by the anchor check, gated in B2, with a substring fallback design ready.
- **Latency is still tight at level 3.** About 3.5–4.2K output tokens per 1,000 words only fits in parallel on a fast provider. B2 measures this before B3 is built.
- **Calibration drift per model.** Re-run the eval whenever `LLM_MODEL` changes.
- **Grammar restructuring is still impossible.** Source text is never rewritten. Accepted for v1; the spec calls it a quality bar, not a rule.
- **Related-language sources** (Catalan, Portuguese, Galician near Spanish) will need re-tuned thresholds if any are added. That's where detection becomes genuinely hard.

---

## Review log

Three adversarial reviewers attacked the first draft independently. They prototyped the aligner, ran `Intl.Segmenter` and eld, and recomputed costs from current OpenRouter prices.

### Technical review

| Finding | What changed |
|---|---|
| NFC normalization broke offsets; the cursor matched the wrong repeat silently; curly quotes, NBSP and sentence-initial capitals dropped items; apostrophe splits accepted | Switched to the index-based format (substring design kept as a measured fallback) |
| Latency didn't fit | Small chunks, all in parallel, compact output |
| Cognates counted as failures | Cognates now count as "not swapped", not as errors |
| The inferred path skipped sanity checks; eld reads only 1,000 characters; the two-pass subset call is redundant and racy | Unrestricted detection on every path, scored in three windows; no `setLanguageSubset` |
| eld's default import may bundle 8.6 MB | Import `eld/extrasmall` only |
| Abbreviations split sentences; long unpunctuated runs never split | Chunker rules added |
| Chunks lose context | Neighbouring sentence passed as context |

### Product / spec review

| Finding | What changed |
|---|---|
| The requested feature shipped last, behind the engine rewrite, and the plan buried the direct answer | Split into Milestones A and B; the answer and cost table now lead |
| Detection was invisible until after the 5–14 s wait | Pre-submit `/api/detect` and source chip; `fallback` renders as a question |
| Ambiguous picker | Labelled "Learning:", with a11y specified |
| English-only chrome for Spanish speakers | Localized string table proposed as an owner decision |
| F4 part of speech left as an open question | `pos` delivered as a one-letter code |
| F5/F6 need the pair recorded | Pair data contract for F5/F6 |
| Behaviour on target change unspecified | Specified |
| Phase 2 pull-forward unstated | Stated |
| ≥98% detection gate meaningless on ~40 samples | Replaced with "no confident misses" |

### Cost / ops review

| Finding | What changed |
|---|---|
| Output tokens underestimated about 2×; concurrency 4 ran chunks in waves; default routing favours the slowest provider | Index format, all chunks in parallel, `sort: 'throughput'` |
| Chunk count not bounded | `MAX_CHUNKS` |
| Abuse could cost $350–1,600/day | Rate limit and spend cap required before Spanish pairs go live |
| Retry storms | Retry budget, no retry on 429 |
| Eval gates unmeasurable at 30 calls; `partial` slipped through | 3× repeats, gates as counts, `partial` counts as a failure, latency measured on a deployed preview |
| Rollback disappears once the tagger is deleted | `ENABLED_PAIRS` kill switch; delete the tagger only after a clean week |
| Debug console public in production | Opt-in proposal |
| eld on joined translations is a weak language check | Replaced by a required judge sample |
| Prompt injection | Translation length and URL caps |

### Technical re-review of the index design

| Finding | What changed |
|---|---|
| Mis-numbering would be a silent wrong-but-valid swap, and a 30-item judge sample can't measure its rate | Anchor word per item, checked and repaired at runtime; mismatch rate gated in B2 |
| Token estimate undersized (measured 4,226 output tokens vs compact substring 3,869) | Estimate corrected to 3.5–4.2K; indices justified by correctness, not tokens; indices are chunk-local |
| Numbers, URLs and emails got indices; a digits-only test misses 3,5 and 1.000 | Numeric = digit and no letter; URLs and emails masked |
| Hyphenated compounds split ("bien-known") | Letter-hyphen-letter merged into one token |
| Sentence validator would reject "EE. UU." | Validator uses the chunker's corrected boundaries |
