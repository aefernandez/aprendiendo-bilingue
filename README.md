# Aprendiendo Bilingüe

Paste any English text and read it partly translated into Italian. Pick how much Italian you want (three levels), then tap any Italian phrase to see what it means.

## Getting started

```bash
npm install
cp .env.example .env.local   # add your OpenRouter key
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

1. `lib/tagger.ts` picks which words to swap for the chosen level, using part-of-speech tags from [compromise](https://github.com/spencermountain/compromise). Names, numbers and contact details are never swapped.
2. `lib/swapEngine.ts` sends the full text plus a numbered list of those phrases to an LLM and asks for a JSON list of translations, checked by index. If the model is slow, down, or returns something unusable, the reader shows the original text with a notice (`degraded: true`).
3. `lib/segmenter.ts` puts each translation back at its exact position in the original text.

## Model and backend

The default model is **Gemma 4 26B-A4B** (`google/gemma-4-26b-a4b-it`) via OpenRouter, with structured JSON output enforced. Any OpenAI-compatible backend works with configuration only — see `.env.example` for running a local model through Ollama or vLLM with no API key.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm test` | Run the unit tests (vitest) |
| `npm run lint` | Lint |
| `npm run build` | Production build |

The product spec lives in `Aprendiendo Bilingue Requirements.md`.
