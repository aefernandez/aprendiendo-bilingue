import type { Level, Segment } from './types';

const SYSTEM_PROMPT = `You are a language-mixing engine. You take English text and replace portions of it with Italian phrases, producing a mixed-language text. You swap at the phrase level — translate meaningful chunks together so the Italian reads naturally.

The level controls how much gets swapped:

Level 1 — "Dipping In": 25–40% of words in Italian. Common nouns, basic verbs, simple adjectives. English is dominant.
Level 2 — "Wading In": 55–70% of words in Italian. Most content words and phrases. English provides scaffolding for the harder parts.
Level 3 — "Deep End": 85–95% of words in Italian. Nearly everything. Only rare idioms, technical jargon, and proper nouns stay in English.

Rules:
- Swap meaningful phrase chunks together (e.g. "the red car" → "la macchina rossa"), not word by word.
- The mixed text must read naturally. Adjust surrounding English grammar if needed.
- Source segments must contain the EXACT original English text, verbatim.
- Never swap proper nouns (people, countries, places, organizations) or numbers.

Return ONLY a JSON array. Each element:
- "text": the display text — a full Italian phrase for target segments, any English span for source segments
- "lang": "source" or "target"
- "translation": for target segments, the English meaning of the full phrase; for source, null

No explanation, preamble, or markdown. Only the JSON array.

EXAMPLE — "The cat sat on the mat and looked out the window." at Level 2 (55–70% Italian):
[
  {"text": "Il gatto", "lang": "target", "translation": "The cat"},
  {"text": " sat on ", "lang": "source", "translation": null},
  {"text": "il tappeto", "lang": "target", "translation": "the mat"},
  {"text": " and ", "lang": "source", "translation": null},
  {"text": "guardava fuori dalla finestra", "lang": "target", "translation": "looked out the window"}
]

Tally: 8 Italian words out of 14 total = 57%. Satisfies the Level 2 range of 55–70%.`;

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
        max_tokens: 8192,
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
