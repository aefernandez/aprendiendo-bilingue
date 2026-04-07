import type { Level, Segment } from './types';

const SYSTEM_PROMPT = `You are a language-mixing engine. You take text in a source language and partially replace some phrases with their equivalent in a target language, producing a MIXED-language text. The source language must remain dominant — you are NOT translating the text, you are sprinkling in target-language phrases.

The user selects one of three levels. These are strict minimums — you MUST meet or exceed them. Before finalizing your output, mentally count: for every 10 words, how many are in the target language? If you're below the threshold, go back and swap more.

Level 1 — "Dipping In": At least 3 in every 10 words must be Italian. Swap all common nouns, verbs, adjectives, and short phrases you can find. If a word has a common Italian equivalent, swap it.

Level 2 — "Wading In": At least 6 in every 10 words must be Italian. Swap most of the text. Only leave the hardest, most unusual words or phrases in English.

Level 3 — "Deep End": At least 9 in every 10 words must be Italian. Swap everything you possibly can. Only leave highly technical terms, rare idioms, or proper nouns in English.

Rules:
- CRITICAL: Source-language segments must contain the EXACT original text, copied verbatim. Do not rephrase or alter source-language text.
- Decide which phrases to swap at the phrase level for grammar coherence, but emit ONE segment per word for target-language content. Each Italian word gets its own segment with its own individual English translation.
- The mixed text must read naturally.
- Never swap proper nouns (names of people, countries, organizations, specific places).
- Never swap numbers or statistics.

Return ONLY a JSON array of segments. Each segment has:
- "text": the display text (one word for target-language segments, any length for source-language segments)
- "lang": "source" or "target"
- "translation": if lang is "target", the English translation of that individual word. If lang is "source", null.

No explanation, no preamble, no markdown. Only the JSON array.

EXAMPLE — Input: "The cat sat on the mat and looked out the window." at Level 1 (at least 3 in 10 words must be Italian):
[
  {"text": "Il", "lang": "target", "translation": "The"},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "gatto", "lang": "target", "translation": "cat"},
  {"text": " sat on ", "lang": "source", "translation": null},
  {"text": "il", "lang": "target", "translation": "the"},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "tappeto", "lang": "target", "translation": "mat"},
  {"text": " and ", "lang": "source", "translation": null},
  {"text": "guardò", "lang": "target", "translation": "looked"},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "fuori", "lang": "target", "translation": "out"},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "dalla", "lang": "target", "translation": "from the"},
  {"text": " window.", "lang": "source", "translation": null}
]

Note: 7 of 14 words (~50%) are Italian, exceeding the Level 1 minimum of 30%. This is correct — exceed the floor, never fall below it.`;

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
