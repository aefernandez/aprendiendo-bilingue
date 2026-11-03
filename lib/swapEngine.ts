import type { Level, Span, SwapResult } from './types';
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

// Total time budget for one swap, across the first call and any retry.
// The spec requires results within 15 s; leave headroom for the response.
export const SWAP_DEADLINE_MS = 14_000;
// Don't start a retry unless at least this much of the budget remains.
const MIN_RETRY_MS = 4_000;
// Upstream error bodies can be large HTML pages or echo the prompt; log a slice.
const MAX_LOGGED_BODY_CHARS = 300;

function fallback(text: string): SwapResult {
  return { segments: [{ text, lang: 'source', translation: null }], degraded: true };
}

async function callModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  userMessage: string,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
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
      const body = await response.text().catch(() => '');
      console.error('LLM error:', response.status, body.slice(0, MAX_LOGGED_BODY_CHARS));
      return null;
    }

    const data = await response.json();
    const content: unknown = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) return null;

    const parsed = JSON.parse(extractJSON(content));
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed as string[];
    }
    return null;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`LLM call failed (${name}): ${message.slice(0, MAX_LOGGED_BODY_CHARS)}`);
    return null;
  }
}

export interface SwapOptions {
  deadlineMs?: number;
}

export async function swap(text: string, level: Level, options: SwapOptions = {}): Promise<SwapResult> {
  const deadlineMs = options.deadlineMs ?? SWAP_DEADLINE_MS;
  const startedAt = Date.now();
  const remaining = () => deadlineMs - (Date.now() - startedAt);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3-8b';
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set — returning original text');
    return fallback(text);
  }

  let spans: Span[];
  try {
    spans = selectSpans(text, level);
  } catch (err) {
    console.error('Tagger error:', err);
    return fallback(text);
  }
  // Nothing worth swapping (e.g. only names and numbers): not a failure.
  if (spans.length === 0) {
    return { segments: [{ text, lang: 'source', translation: null }], degraded: false };
  }

  // First attempt: full context + numbered list
  let translations = await callModel(baseUrl, apiKey, model, buildUserMessage(text, spans), remaining());

  // Retry with context-free prompt if count mismatches, time permitting
  if (!translations || translations.length !== spans.length) {
    if (remaining() < Math.min(MIN_RETRY_MS, deadlineMs / 3)) {
      console.error('No time left to retry — returning original text');
      return fallback(text);
    }
    console.warn(`Count mismatch (got ${translations?.length ?? 0}, expected ${spans.length}). Retrying.`);
    translations = await callModel(baseUrl, apiKey, model, buildRetryMessage(spans), remaining());
  }

  if (!translations || translations.length !== spans.length) {
    console.error('Translation count mismatch after retry — returning original text');
    return fallback(text);
  }

  return { segments: reconstructSegments(text, spans, translations), degraded: false };
}
