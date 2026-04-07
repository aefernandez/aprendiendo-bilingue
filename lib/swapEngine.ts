import type { Level, Segment } from './types';

const SYSTEM_PROMPT = `You are a language-mixing engine. You take text in a source language and partially replace phrases with their equivalent in a target language, creating a readable mixed-language text.

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

No explanation, no preamble, no markdown. Only the JSON array.`;

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
