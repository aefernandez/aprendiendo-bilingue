# Plan: target-language selection with automatic source detection

*Status: draft for review · Nov 2026*

## Summary

- **The user picks the target language; the app works out the source.** Detecting the source is not meaningfully harder than asking for it, because for each target only a few sources are valid: target English → source Spanish; target Italian → source Spanish or English. Detection is a constrained choice, not open-ended language identification. A manual override always exists.
- **The real work is not detection.** Span selection uses compromise, which is English-only, and two of three launch pairs have a Spanish source. This plan moves span selection into the LLM for every pair, keeps offset-anchoring so the source text can't be rewritten, and splits long texts into chunks to stay inside the 15 s budget.
- **Six small PRs, each cut from `main`.** None is stacked on another PR's branch.

## 1. Source language: detect, don't ask

### Does the app need to know the source?

Yes, for the prompt ("Spanish → Italian"), the definition card ("translation back to the source language"), `lang` attributes for screen readers, validating source ≠ target, and later the frequency tiers and SRS storage keyed by language. Once span selection moves into the LLM, the tagger no longer needs it. `Intl.Segmenter` produced identical word segmentation for `it`, `es` and `en` on a mixed test string, so the segmenter locale is not a blocker.

### Detector choice (measured)

44 hard samples: short sentences, tweets, mixed text, Italian/Spanish cognates, Portuguese, name-heavy text, single words.

| Detector | Correct | Notes |
|---|---|---|
| franc-min 6.2.0, all languages | 23/44 | Returned Tagalog, Hausa, Romanian on short text. Unusable. |
| tinyld 1.3.4, restricted to es/en/it/pt | 40/44 | Last published Jan 2024 |
| **eld 2.1.0 (extrasmall), restricted to es/en/it/pt** | **41/44** | Apache-2.0, pure ESM, maintained (Aug 2026) |
| eld, Spanish vs English only (the choice the app actually makes) | 27/28 | The miss was a sports score line full of Spanish place names |

eld runs in about 0.01 ms per call (0.25 ms for a 931-word article). Its data is about 954 KB raw / 279 KB gzipped, so it runs **server-side in the route handler**, not in the client bundle. Cold import measured 172 ms locally.

Use the **margin between the top two scores** as confidence (start at 0.05, tune on real articles). eld's `isReliable()` stayed true on wrong cognate guesses.

### Resolution order (`lib/sourceLanguage.ts`)

`resolveSource(text, requested, target)` returns `{ lang, method: 'selected' | 'inferred' | 'detected', confidence? }` or an error:

1. **Selected:** the user chose a source explicitly → use it.
2. **Inferred:** only one source is valid for the target (target English → Spanish) → use it, no detection.
3. **Detected:**
   1. First run eld unrestricted. If the top language isn't a supported source (Portuguese, French…) with good margin → error "This looks like Portuguese, which isn't supported yet."
   2. If it equals the target → error "This already looks like Italian."
   3. Otherwise run eld restricted to `sourcesFor(target)`. If the margin is low or the text is under ~20 characters → fall back to the last-used source for this target (sent by the client), or the pair's default, with `method: 'inferred'`.

Errors return **422** `{ error, detectedLang }` so the UI can offer a fix.

### What changes if we ever drop detection

Only step 3 and the "Detected" chip. The API, registry, engine, aligner and eval are identical, and the UI becomes a three-option pair picker.

## 2. Span selection: the LLM chooses spans for every pair

### Decision

The LLM returns `{"items":[{"src","tgt","pos"}]}`. `src` must be a verbatim substring of the input. A pure aligner places each item and drops any it can't place. compromise (`lib/tagger.ts`) stays behind a flag during rollout, then is deleted.

### Alternatives rejected

- **compromise for English plus something else for Spanish:** two selectors with different behaviour and calibration. There is no good Spanish POS tagger in JS without a large model. Every new language adds a code path, which breaks the spec's "add pairs without structural changes".
- **Tagger proposes, LLM filters:** still English-only at the proposing step.

### Aligner (`lib/align.ts`)

`alignItems(text, items) → { spans, translations, dropped }`:

- Normalize both sides to NFC.
- For each item in order, search `indexOf(src, cursor)` and accept only matches at word boundaries (no letter or combining mark immediately before or after). Otherwise Spanish `a`/`y`/`el` would match inside `casa`/`muy`/`papel`.
- No match → drop the item and don't advance the cursor.
- Reject items that are empty, have no letter, have `tgt` equal to `src` (case-insensitive), or have a newline in `src`.
- If more than 40% of a chunk's items are dropped, treat the attempt as failed and retry that chunk.

`reconstructSegments` is unchanged: the aligner produces the same `Span[]` and `translations[]` as the tagger did.

### Latency: chunk and run in parallel

At level 3, a 1,000-word text needs roughly 3–3.5K output tokens (both `src` and `tgt`). At 80–150 tokens/s, one serial call would exceed 15 s.

- Split with `Intl.Segmenter(sourceLocale, { granularity: 'sentence' })` into paragraph-respecting chunks of at most 1,200 characters: about 5 chunks per 1,000 words, at most 10 at the 12,000-character cap.
- Run up to 4 chunks concurrently, each with its own retry, all inside the shared 14 s deadline.
- A failed chunk falls back to its source text alone. The response gets `partial: true` instead of the whole text degrading.

### Cost

About twice today's output tokens, roughly $0.0005–0.001 per article on Gemma 4 26B-A4B.

### Calibration (~30/60/90%)

LLMs don't hit percentages reliably, so measure instead of trusting the prompt:

- The prompt uses the spec's level rubrics plus "aim for roughly N% of words".
- The aligner computes **coverage**, the share of word-like source tokens covered by aligned spans, and logs it to diagnostics.
- The eval scores coverage against per-level bands.
- If the eval shows systematic overshoot, add a deterministic guard that trims the longest items first (follow-up, not v1).

## 3. Language registry (`lib/languages.ts`, data only)

```ts
export const LANGUAGES = {
  en: { code: 'en', name: 'English', endonym: 'English', locale: 'en' },
  es: { code: 'es', name: 'Spanish', endonym: 'Español', locale: 'es' },
  it: { code: 'it', name: 'Italian', endonym: 'Italiano', locale: 'it' },
} as const satisfies Record<string, Language>;

export const PAIRS: Pair[] = [
  { source: 'es', target: 'en', enabled: true },
  { source: 'en', target: 'it', enabled: true },
  { source: 'es', target: 'it', enabled: true },
];
export const DEFAULT_PAIR = { source: 'en', target: 'it' }; // today's behaviour
```

- `Pair.promptNotes?` holds pair-specific hints (e.g. "swap Spanish contractions del/al whole").
- Helpers: `isEnabledPair`, `targets()`, `sourcesFor(target)`.
- A test checks that every pair uses known codes and every locale constructs `Intl.Segmenter` and `Intl.DisplayNames`.
- Adding a pair means adding an entry. Adding a language also adds a `LANGUAGES` entry (and later `data/freq/<code>.json`) plus that language in the detector subset.

## 4. API contract

### Request

`{ text, level, targetLang?, sourceLang?: LangCode | 'auto', lastSource? }`

- No language fields → `DEFAULT_PAIR` (en→it), so today's clients and tests keep working.
- `targetLang` alone → source `auto`.
- Unknown codes or disabled pairs → 400 with a readable message ("Spanish → German isn't supported yet").

### Response

Today's `SwapResult` plus:

- `sourceLang` and `targetLang`: the resolved values.
- `source: { method, confidence? }`
- `partial?: true`
- `Segment.pos?`

`degraded` stays a boolean.

## 5. Engine interface and prompts (`lib/swapEngine.ts`, still one module)

```ts
export interface SwapInput { text: string; sourceLang: LangCode; targetLang: LangCode; level: Level; userWords?: string[] }
export interface SwapEngine { swap(input: SwapInput, opts?: SwapOptions): Promise<SwapResult> }
```

- The route calls `resolveSource()`, then `engine.swap()`.
- Prompts become `buildPrompts(pair, level, chunk)`: one template filled from `LANGUAGES` and `pair.promptNotes`.
- `RESPONSE_FORMAT` switches to the `items` schema. `parseTranslations` becomes `parseItems`, keeping the `<think>`, code-fence and bare-array tolerance.
- `maxTokensFor` scales with chunk length and level.
- `SWAP_SPANS=tagger|llm` keeps the old path (en→it only) for side-by-side evaluation during rollout.

## 6. UI

### Target picker

`app/LanguagePicker.tsx` sits above the textarea as a segmented control: "English | Italiano" (endonyms).

- **Persistence:** `localStorage['ab.target.v1']`, read via `useSyncExternalStore` to avoid a hydration mismatch.
- **Default target when nothing is stored:** English if `navigator.language` starts with `es`, otherwise Italian.

### Source chip

After a result, the reader header shows "Detected: Español ▾ → Italiano".

- Tapping the chip lists the valid sources. Picking one re-runs the swap with `sourceLang` set and remembers it for that target in this session.
- When the source was inferred (only one option), the chip shows without "Detected".
- A 422 shows its message under the textarea with a one-tap fix: switch target, or pick the source.

### Copy and locale

- Copy derived from the registry: `~30% {target}`, "How much {target} do you want?", "Paste {sources} text here…", "Tap any {target} word". Tagline: "Read anything in your target language, starting today." (also in `layout.tsx` metadata).
- UI chrome stays English for v1 (`<html lang="en">`). Localizing it is an open question.
- `lang` attributes: the reader paragraph gets `lang={source.locale}`; each target span gets `lang={target.locale}`. This fixes review item M7 for screen readers and hyphenation.
- `expandToWords(segments, targetLocale)` uses a per-locale `Intl.Segmenter` cache instead of the hard-coded `'it'`.

## 7. Diagnostics (debug console)

New server events:

- `Pair es→it (source: detected, margin 0.21)`
- `Chunk 3/5: 18 items, 2 dropped (742 ms)`, with the dropped `src` strings as detail
- `Coverage 34% (level 1 band 15–45%)`
- `Partial: 1 of 5 chunks fell back`

The client logs target and source changes. The existing `NEXT_PUBLIC_DEBUG_CONSOLE=false` switch strips all of it.

## 8. Testing

### Unit tests (CI)

| Test file | Covers |
|---|---|
| `align.test.ts` | Accents and NFC/NFD, repeated words, word boundaries (`a` vs `casa`), out-of-order and hallucinated items, `tgt === src`, newline in `src` |
| Chunker tests | Paragraphs preserved, ≤1,200 characters, offsets round-trip |
| `sourceLanguage.test.ts` | Selected, inferred and detected paths; unsupported language, source equals target, short text, low margin |
| `languages.test.ts` | Registry invariants |
| `validation.test.ts` | Pair rules; a legacy `{text, level}` request still works |
| `swapEngine.test.ts` | Mocked es→en and es→it runs, per-chunk retry and partial fallback, prompt snapshot per pair |

### Golden eval (`eval/`, run manually, not in CI)

**Fixtures:** 20 texts, 10 English and 10 Spanish: news, email, social post, recipe. Each lists its protected tokens (names, numbers). Plus first-sentence variants for detection.

**Run:** Spanish texts go through both Spanish pairs, English texts through en→it. That's 30 text-pairs × 3 levels = 90 calls, about $0.10 and about 3 minutes at concurrency 6. Command: `EVAL=1 npx vitest run eval/` with a separate config. Results go to `eval/results/` (gitignored); a baseline summary is committed.

**Scores:**
- Non-degraded rate
- Alignment drop rate
- Coverage within the level band
- Protected tokens preserved
- Target-language check: eld run on the joined `tgt` strings
- Source-leak rate
- Detection accuracy
- p50/p95 latency
- Output tokens

**Optional:** `--judge` has a stronger model rate readability on a sample.

**Ship gate for the engine switch, per pair:**
- Non-degraded ≥ 97%
- Drop rate ≤ 10%
- Coverage medians inside their bands
- p95 latency < 12 s

## 9. Rollout

Every PR branches from fresh `origin/main` and targets `main`. A PR that depends on another waits for that one to merge, then is cut fresh from `main`. (Last time, stacked PRs merged into each other's branches and production missed three fixes.)

1. **Registry and plumbing, no behaviour change** (~250 lines)
   - `languages.ts`, the `SwapInput`/`SwapEngine` interface, language-parameterized prompts, new request fields with defaults, locale-aware segmenter, `lang` attributes, registry-driven copy.
   - Only en→it is enabled.
   - *Accept:* existing tests pass; legacy requests behave the same; `lang="it"` appears on target spans.
2. **Eval harness and fixtures** (~300 lines plus fixtures; can be built alongside PR 1)
   - *Accept:* an en→it baseline on the current tagger engine is committed.
3. **LLM span selection, chunking and aligner** behind `SWAP_SPANS` (~400 lines)
   - *Accept:* unit tests pass; the eval meets the gate for all three pairs (Spanish pairs force-enabled in the eval only); then flip the default to `llm`.
4. **Source detection** (~150 lines plus the eld dependency)
   - *Accept:* ≥ 98% on fixture texts and their first sentences; low-confidence, unsupported and source-equals-target paths covered by tests.
5. **Target picker, source chip, enable the Spanish pairs** (~200 lines)
   - *Accept:* the target choice survives a reload; overriding the source re-runs the swap; manual QA on a phone for all three pairs.
6. **Delete compromise and `tagger.ts`**, after a week on `llm`.
7. **Later:** frequency tiers in the prompt (`data/freq/*.json`); the coverage guard if the eval shows drift.

## 10. Risks and open questions

### Risks

- **Latency** depends on OpenRouter rate limits for parallel calls. Measure p95 per provider; reduce chunk size or concurrency if needed.
- **Calibration drifts per model.** Re-run the eval whenever `LLM_MODEL` changes.
- **Grammar restructuring** is still impossible with verbatim offsets. Accepted for v1; the spec calls it a quality bar.
- **Cross-chunk agreement** (pronoun gender) may suffer. Option: pass the previous sentence as read-only context.
- **Abuse:** 5–10 upstream calls per request instead of 1–2 makes rate limiting more urgent.
- **Detection gets genuinely harder** if pairs with closely related sources are added (es/pt/it/ca/fr as sources for the same target).

### Open questions

- Localize UI chrome for Spanish-source users?
- Is `pos` worth its output tokens before F4 ships?
- Does `partial` deserve a banner?
