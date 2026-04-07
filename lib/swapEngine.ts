import type { Level, Segment } from './types';

const SYSTEM_PROMPT = `You are a language-mixing engine. You take text in a source language and partially replace some phrases with their equivalent in a target language, producing a MIXED-language text. The source language must remain dominant — you are NOT translating the text, you are sprinkling in target-language phrases.

The user selects one of three levels. Treat each percentage as a MINIMUM FLOOR — you must meet or exceed it. When in doubt, swap more, not less.

Level 1 — "Dipping In": At least 30% of words must be in the target language. Swap the most common, everyday vocabulary: basic nouns (house, food, water), common verbs (to go, to have, to want), simple adjectives, short phrases.

Level 2 — "Wading In": At least 60% of words must be in the target language. Swap most vocabulary including less common words, longer phrases, and full clauses. Source language provides light scaffolding only.

Level 3 — "Deep End": At least 90% of words must be in the target language. Swap nearly everything — only leave complex idioms, technical jargon, or rare vocabulary in the source language.

Rules:
- CRITICAL: Source-language segments must contain the EXACT original text, copied verbatim. Do not rephrase or alter source-language text.
- Swap at the phrase level, not individual words. Translate meaningful chunks.
- The mixed text must read naturally.
- Never swap proper nouns (names of people, countries, organizations, specific places).
- Never swap numbers or statistics.

Return ONLY a JSON array of segments. Each segment has:
- "text": the display text
- "lang": "source" or "target"
- "translation": if lang is "target", the original source-language phrase. If lang is "source", null.

No explanation, no preamble, no markdown. Only the JSON array.

EXAMPLE — Input: "The cat sat on the mat and looked out the window." at Level 1:
[
  {"text": "Il gatto", "lang": "target", "translation": "The cat"},
  {"text": " sat on ", "lang": "source", "translation": null},
  {"text": "il tappeto", "lang": "target", "translation": "the mat"},
  {"text": " and looked out ", "lang": "source", "translation": null},
  {"text": "la finestra", "lang": "target", "translation": "the window"},
  {"text": ".", "lang": "source", "translation": null}
]`;

function extractJSON(raw: string): string {
  // Strip thinking tags (Qwen3 and similar models)
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');

  if (start === -1 || end === -1) {
    throw new Error('No JSON array found in model response');
  }

  return text.slice(start, end + 1);
}

function fallback(text: string): Segment[] {
  return [{ text, lang: 'source', translation: null }];
}

export async function swap(text: string, level: Level): Promise<Segment[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3-8b';
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set — returning original text');
    return fallback(text);
  }

  const userMessage = `Source language: English
Target language: Italian
Level: ${level}

Text:
${text}`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://aprendiendo-bilingue.vercel.app',
        'X-Title': 'Aprendiendo Bilingue',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      console.error('OpenRouter error:', response.status, await response.text());
      return fallback(text);
    }

    const data = await response.json();
    const content: string | undefined = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('Empty content in OpenRouter response');
      return fallback(text);
    }

    const segments = JSON.parse(extractJSON(content)) as Segment[];

    if (!Array.isArray(segments) || segments.length === 0) {
      return fallback(text);
    }

    return segments;
  } catch (err) {
    console.error('Swap engine error:', err);
    return fallback(text);
  }
}
