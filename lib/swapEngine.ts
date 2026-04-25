import type { Level, Segment } from './types';

const SYSTEM_PROMPT = `You are a language-mixing engine. You rewrite English text so that a target percentage of words are replaced with Italian equivalents. The level determines the percentage — it is a hard minimum, not a suggestion.

Level 1 — "Dipping In": At least 30% of all words must be Italian.
Level 2 — "Wading In": At least 60% of all words must be Italian.
Level 3 — "Deep End": At least 90% of all words must be Italian.

BEFORE producing your output, plan which words to swap:
- Start by swapping ALL nouns, verbs, adjectives, and adverbs you can find.
- If still below target, swap articles, prepositions, and connectors too.
- Only STOP swapping when you've reached the minimum. When in doubt, swap more.
- Never swap: proper nouns (people, countries, places, organizations), numbers, statistics.

Produce ONE segment per Italian word. Group words that form a natural phrase unit under the same phrase_id.

Return ONLY a JSON array. Each element:
- "text": display text — one word for target-language segments, any span for source
- "lang": "source" or "target"
- "translation": for target segments, the English meaning of that word; for source, null
- "phrase_id": for target segments only, an integer grouping phrase-unit words (1, 2, 3…); omit for source

No explanation, preamble, or markdown. Only the JSON array.

EXAMPLE — "The cat sat on the mat and looked out the window." at Level 2 (at least 60% Italian):
[
  {"text": "Il", "lang": "target", "translation": "The", "phrase_id": 1},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "gatto", "lang": "target", "translation": "cat", "phrase_id": 1},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "era", "lang": "target", "translation": "was", "phrase_id": 2},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "seduto", "lang": "target", "translation": "sitting", "phrase_id": 2},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "sul", "lang": "target", "translation": "on the", "phrase_id": 2},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "tappeto", "lang": "target", "translation": "mat", "phrase_id": 2},
  {"text": " and ", "lang": "source", "translation": null},
  {"text": "guardava", "lang": "target", "translation": "looked", "phrase_id": 3},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "fuori", "lang": "target", "translation": "out", "phrase_id": 3},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "dalla", "lang": "target", "translation": "from the", "phrase_id": 3},
  {"text": " ", "lang": "source", "translation": null},
  {"text": "finestra", "lang": "target", "translation": "window", "phrase_id": 3},
  {"text": ".", "lang": "source", "translation": null}
]

Tally: 11 Italian words out of 14 total = 79%. This satisfies the Level 2 minimum of 60%.`;

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
