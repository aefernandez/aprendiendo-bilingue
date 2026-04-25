import type { Level, Segment, Span } from './types';
import { selectSpans } from './tagger';
import { reconstructSegments } from './segmenter';

const SYSTEM_PROMPT = `You are a translation engine. Translate English phrases to Italian.
Use the full text provided for grammatical context — ensure correct tense, gender, and number agreement.
Return ONLY a JSON array of translations. The array must have exactly as many items as numbered phrases.
No explanation, preamble, or markdown. Only the JSON array.`;

function buildUserMessage(text: string, spans: Span[]): string {
  const phraseList = spans.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  return `Full text: ${text}

Translate each phrase to Italian:
${phraseList}

Return a JSON array with exactly ${spans.length} translations: ["it1","it2",...]`;
}

function buildRetryMessage(spans: Span[]): string {
  const phraseList = spans.map((s, i) => `${i + 1}. "${s.text}"`).join('\n');
  return `Translate each phrase from English to Italian.
You MUST return exactly ${spans.length} translations — one per numbered phrase.

${phraseList}

Return ONLY: ["translation1","translation2",...] with exactly ${spans.length} items.`;
}

function extractJSON(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');
  return text.slice(start, end + 1);
}

function fallback(text: string): Segment[] {
  return [{ text, lang: 'source', translation: null }];
}

async function callModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  userMessage: string,
): Promise<string[] | null> {
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
      temperature: 0,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    console.error('OpenRouter error:', response.status, await response.text());
    return null;
  }

  const data = await response.json();
  const content: string | undefined = data.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(extractJSON(content));
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed as string[];
    }
    return null;
  } catch {
    return null;
  }
}

export async function swap(text: string, level: Level): Promise<Segment[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3-8b';
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set — returning original text');
    return fallback(text);
  }

  let spans: ReturnType<typeof selectSpans>;
  try {
    spans = selectSpans(text, level);
  } catch (err) {
    console.error('Tagger error:', err);
    return fallback(text);
  }
  if (spans.length === 0) return fallback(text);

  try {
    // First attempt: full context + numbered list
    let translations = await callModel(baseUrl, apiKey, model, buildUserMessage(text, spans));

    // Retry with context-free prompt if count mismatches
    if (!translations || translations.length !== spans.length) {
      console.warn(`Count mismatch (got ${translations?.length ?? 0}, expected ${spans.length}). Retrying.`);
      translations = await callModel(baseUrl, apiKey, model, buildRetryMessage(spans));
    }

    if (!translations || translations.length !== spans.length) {
      console.error('Translation count mismatch after retry — returning original text');
      return fallback(text);
    }

    return reconstructSegments(text, spans, translations);
  } catch (err) {
    console.error('Swap engine error:', err);
    return fallback(text);
  }
}
