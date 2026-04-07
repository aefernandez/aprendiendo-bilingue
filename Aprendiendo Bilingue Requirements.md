# Aprendiendo Bilingue Requirements and Design 

## product Vision

A language learning app that takes any text the user provides and partially translates it into their target language, creating a mixed-language reading experience. Users progressively encounter more target-language vocabulary as they advance. Tapping any translated word reveals its definition and adds it to a spaced-repetition review list.

**Positioning:** “Read anything in your target language, starting today.”

-----

## Core Concept

The user pastes text in their source language. The app returns a version of that text where a portion of the content has been replaced with equivalent phrases in the target language. The user controls how much gets translated via a manual dial (percentage slider). The result is a readable, mixed-language text that introduces vocabulary in natural context.

-----

## Supported Language Pairs (Launch)

|Source Language|Target Language|
|---------------|---------------|
|Spanish        |English        |
|English        |Italian        |
|Spanish        |Italian        |

The app architecture must support adding new language pairs without structural changes. Language pair selection should be a user-facing setting.

-----

## User Personas

**Primary:** Serious self-study language learners. These users are motivated, will use the app regularly, and care about measurable progress. They are likely already intermediate or approaching intermediate level, and want to build vocabulary through immersion in content they care about.

-----

## Core User Flow

1. User selects their source → target language pair.
1. User pastes text (article, email, social media post, anything).
1. User sets the translation dial (e.g., 10%–90%).
1. App returns the mixed-language text.
1. User reads. Taps any target-language word/phrase to see its definition.
1. Tapped words are automatically added to the user’s learning list.
1. User reviews saved words via spaced-repetition flashcards.

-----

## Feature Specifications

### F1: Text Input

- Free-form text input area.
- No length limit enforced in MVP, but consider UX for very long texts (a news article is a reasonable upper bound for v1).
- Source language should be auto-detected or inferred from the selected language pair.

### F2: Translation Level Selector

Three buttons, not a slider. Each level has a descriptive label:

- **Level 1 — “Dipping In” (~30%):** Only the most common, everyday vocabulary gets swapped. Basic nouns, common verbs, simple phrases. The text feels firmly in the source language with the target language sprinkled in.
- **Level 2 — “Wading In” (~60%):** A substantial portion is in the target language. Includes less common vocabulary, longer phrases, and some full clauses. The source language acts as scaffolding for the harder parts.
- **Level 3 — “Deep End” (~90%):** Nearly everything is in the target language. Only complex idiomatic expressions, technical jargon, or rare vocabulary stays in the source language. Near-full immersion.

The percentages are approximate guides, not targets. The UI should clearly communicate what the levels mean (e.g., “How much [Italian] do you want?”).

### F3: The Swap Engine

This is the core of the product. It takes source text, a target language, and a dial level, and returns mixed-language text with metadata.

**Swap Algorithm — Model A (v1):**

- Uses word/phrase frequency data for the target language to guide which vocabulary gets swapped at each level.
- Level 1 targets the most common/frequent vocabulary. Level 2 broadens to less common words. Level 3 swaps nearly everything.
- Frequency tiers (suggested starting point): Tier 1 = top 500 words, Tier 2 = 500–1500, Tier 3 = 1500–3000, Tier 4 = 3000+.

**Critical design constraint — swappability:** The swap engine must be behind a clean interface so the algorithm can be replaced later (e.g., with a user-history-aware model) without changing the rest of the app. The contract:

- **Input:** source text, source language, target language, dial level (and in future versions: user word list, learning history).
- **Output:** structured mixed-language text where each segment is tagged with: the display text, whether it’s source or target language, the original text in the other language (for definitions), and any relevant metadata.

**Phrase-level swapping:** The unit of translation is the meaningful phrase/chunk, not individual words. Examples: “the red car” → “la macchina rossa”, not word-by-word replacement. This preserves readability and teaches natural phrasing.

**Grammar coherence:** Mixed sentences must read naturally. The target-language phrases may require the surrounding source-language text to be slightly restructured. This is a quality bar, not a rigid rule — prioritize readability. An LLM is the recommended approach for this, as rule-based systems will struggle with the grammar interplay.

**Non-determinism is acceptable.** Re-processing the same text may yield different phrase selections. This is a feature, not a bug — it means re-reading a favorite text exposes new vocabulary.

**Latency requirement:** The swap engine must return results within 15 seconds for a typical input (up to ~1000 words). The UI should show a loading/progress indicator during processing. 

### F4: Tap-to-Define

- Any target-language word or phrase in the output is tappable.
- Tapping displays a definition card showing: the word/phrase in the target language, its translation back to the source language, and the part of speech.
- Tapping also automatically adds the word to the user’s learning list (silently, no confirmation needed — the user should see a subtle visual indicator that it was saved).
- If a word is already in the learning list, indicate that visually (e.g., a small checkmark or different highlight color).

### F5: Learning List & Spaced Repetition

- A dedicated section of the app where users review saved words.
- Uses spaced-repetition scheduling (SM-2 or FSRS algorithm).
- Flashcard format: show the target-language word/phrase, user tries to recall the meaning, then reveals the translation.
Track basic stats: total words saved to start with flexibility for future additions. 
Words should store: target-language text, source-language translation, date added, SRS scheduling data, and the original context sentence they were encountered in.

### F6: Reading History

- Keep a list of previously processed texts so users can re-read them.
- Store the original text and the generated mixed-language version.
- Allow re-processing a saved text at a different dial setting.

-----

## Architecture Guidance

### Recommended Stack (suggestions, not prescriptions)

- **Frontend:** React-based web app, designed mobile-first. Consider PWA for installability. The priority is a clean, readable text display — this is a reading app.
- **Swap Engine:** LLM API calls (e.g., Anthropic Claude API). The prompt should receive structured input (text, language pair, frequency tier cutoff) and return structured output (tagged segments). Keep the prompt engineering in a single, well-documented module.
- **Frequency Data:** Static JSON files containing frequency-ranked word lists per language. Source from open linguistic corpora.
- **User Data:** Local storage or a lightweight backend (SQLite, Supabase, Firebase) for the learning list, SRS data, and reading history.
- **SRS Algorithm:** Use an established open-source implementation rather than building from scratch.

### Key Architectural Principles

- **Separation of concerns:** The swap engine, the UI rendering, the SRS system, and user data management should be independent modules.
- **Swap engine interface:** Must be a clean abstraction that can be reimplemented without touching the rest of the app.
- **Structured output:** The swap engine should return data, not formatted text. The UI layer handles all rendering decisions.
- **Graceful degradation:** If the LLM API is unavailable or slow, the app should show the original text rather than an error state.

### LLM Backend Strategy

**Phase 1 — Cloud API (development and initial use):**

- Use a cloud LLM API (e.g., Anthropic Claude) for the swap engine.
- Expected cost for casual use (a few users processing a handful of articles per day): roughly $5–20/month.
- This keeps infrastructure simple while you iterate on prompt engineering — the most important variable to get right early.

**Phase 2 — Local model migration (when ready):**

- Transition to a self-hosted open-source model (e.g., Llama 3, Mistral, 7B–13B parameter range).
- Serve via Ollama, vLLM, or similar local inference server.
- Hardware target: a machine with 24GB VRAM (e.g., NVIDIA RTX 3090) can serve a 13B model comfortably.
- The phrase-swapping task is well-bounded and doesn’t require frontier-model reasoning, so smaller models should perform well — especially for well-resourced languages like Spanish, English, and Italian.

**Backend abstraction requirement:**

- The swap engine module must accept configuration for its LLM backend: API endpoint URL, model name, and authentication (API key or none for local).
- Switching from a cloud API to a local model should require only a configuration change (e.g., endpoint from `https://api.anthropic.com/...` to `http://localhost:11434/...`), not a code change.
- All prompt templates, structured output parsing, and retry logic should be backend-agnostic — they work identically regardless of which LLM is behind the endpoint.

-----

## Out of Scope for v1

- Offline support (requires caching strategy and potentially a local model).
- Adaptive/automatic dial adjustment based on learning history.
- Audio pronunciation.
- User accounts with cloud sync (local-only is fine for v1).
- Content library or curated lessons.
- Grammar explanations.
- Multiple simultaneous language pairs per user.
- Social features.

-----

## Monetization (Deferred)

Plan is one-time purchase model. However, note the tension: LLM API calls create ongoing per-user costs. Revisit pricing model before launch. Consider: one-time purchase with a monthly processing cap, or credit-based system for heavy users.

-----

## Success Metrics (Post-Launch)

- Words added to learning lists per session.
- Return rate (do users come back within 7 days?).
- Dial progression over time (are users increasing their target-language percentage?).
- Flashcard review completion rate.

-----

## Open Questions for Development

1. **Prompt engineering:** What prompt structure produces the most natural mixed-language output? This will require iteration and testing across all three language pairs.
1. **Long text handling:** Should very long texts be chunked into pages/sections, or presented as a scroll? Test both.
**Frequency list granularity:** Are 4 tiers enough, or do we need finer-grained control? Start with 4, test with real users

## Development Phases

### Phase 1 — Proof of Concept

Single page: paste text, set dial, get mixed output, tap words for definitions. No persistence, no accounts, no SRS. One language pair only. Goal: validate that the mixed-language output is readable and useful.

### Phase 2 — Core Loop

Add learning list, SRS flashcard review, reading history. All three language pairs. Goal: a complete learning loop that a real user could use daily.

### Phase 3 — Polish & Launch

PWA packaging, onboarding flow, visual polish, error handling, usage tracking. Goal: a product someone would pay for.

-----

## Reference Prompt (Swap Engine)

This is a tested starting point for the LLM prompt. It should live in a single, well-documented module and be easy to iterate on.

**System prompt:**

```
You are a language-mixing engine. You take text in a source language and partially replace phrases with their equivalent in a target language, creating a readable mixed-language text.

The user selects one of three levels:

Level 1 — "Dipping In": Swap only the most common, everyday vocabulary. Basic nouns (house, food, water), common verbs (to go, to have, to want), simple phrases (good morning, in the world, a lot of). The text should feel firmly in the source language with the target language sprinkled in.

Level 2 — "Wading In": Swap a substantial portion of the text. Include less common vocabulary, longer phrases, and some full clauses. The source language acts as scaffolding for the harder parts.

Level 3 — "Deep End": Swap nearly everything. Only complex idiomatic expressions, technical jargon, or rare vocabulary stays in the source language. This is near-full immersion.

Rules:
- Swap at the phrase level, not individual words. Translate meaningful chunks (e.g., "the tropical country" → "il paese tropicale").
- The mixed text must read naturally. Adjust surrounding grammar if needed so sentences flow.
- Never swap proper nouns (names of people, countries, organizations, specific places).
- Never swap numbers or statistics.

Return ONLY a JSON array of segments. Each segment is an object with:
- "text": the display text
- "lang": "source" or "target"
- "translation": if lang is "target", the original source-language phrase. If lang is "source", null.

No explanation, no preamble, no markdown. Only the JSON array.
```

**User message format:**

```
Source language: {source_language}
Target language: {target_language}
Level: {1, 2, or 3}

Text:
{user_pasted_text}
```

**Expected output format (example — English→Italian, Level 2):**

```json
[
  {"text": "Missili e droni", "lang": "target", "translation": "Missiles and drones"},
  {"text": " seem ", "lang": "source", "translation": null},
  {"text": "un mondo lontano", "lang": "target", "translation": "a world away"},
  {"text": " from Guyana. ", "lang": "source", "translation": null},
  {"text": "Il paese tropicale", "lang": "target", "translation": "The tropical country"},
  {"text": " of fewer than 1m ", "lang": "source", "translation": null},
  {"text": "persone", "lang": "target", "translation": "people"},
  {"text": " is perched on the north-eastern edge of South America.", "lang": "source", "translation": null}
]
```
