import type { Level, Span, SwapResult } from './types';
import { selectSpans } from './tagger';
import { reconstructSegments } from './segmenter';
import { loadLlmConfig, missingKey, type LlmConfig } from './llmConfig';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a translation engine. Translate English phrases to Italian.
Each phrase is taken from the full text and its translation will replace it in place, so use the full text for grammatical context — ensure correct tense, gender, and number agreement.
Return ONLY a JSON object of the form {"translations":[{"i":1,"t":"..."},{"i":2,"t":"..."}]}: one item per numbered phrase, in order, where "i" is the phrase number and "t" is its Italian translation. Never put the number inside "t".
No explanation, preamble, or markdown. Only the JSON object.`;

function phraseList(spans: Span[]): string {
  return spans.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
}

function buildUserMessage(text: string, spans: Span[]): string {
  return `Full text: ${text}

Translate each phrase to Italian:
${phraseList(spans)}

Return {"translations":[...]} with exactly ${spans.length} items, numbered 1 to ${spans.length}.`;
}

// The retry keeps the full text: without it the model can't resolve gender,
// number or tense, which is exactly what tends to go wrong the first time.
function buildRetryMessage(text: string, spans: Span[]): string {
  return `${buildUserMessage(text, spans)}

Your previous answer was not valid. You MUST return exactly ${spans.length} items, one per numbered phrase, with "i" from 1 to ${spans.length} and a non-empty "t" for each.`;
}

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'translations',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              i: { type: 'integer' },
              t: { type: 'string' },
            },
            required: ['i', 't'],
            additionalProperties: false,
          },
        },
      },
      required: ['translations'],
      additionalProperties: false,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function between(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * Turns the model's reply into exactly `count` translations, in phrase order,
 * or null if the reply can't be trusted. Accepts the structured
 * {"translations":[{"i","t"}]} shape, and a bare array of strings from
 * backends without structured outputs.
 */
export function parseTranslations(content: string, count: number): string[] | null {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  // An unclosed thinking block means the answer was cut off.
  if (text.includes('<think>')) return null;
  text = text.replace(/```(?:json)?/g, '').trim();

  const parsed =
    tryParse(text) ??
    tryParse(between(text, '{', '}') ?? '') ??
    tryParse(between(text, '[', ']') ?? '');

  const items: unknown =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { translations?: unknown }).translations
      : parsed;
  if (!Array.isArray(items) || items.length !== count) return null;

  const result: (string | undefined)[] = new Array(count);
  for (let position = 0; position < items.length; position++) {
    const item = items[position];
    let index: unknown = position + 1;
    let translation: unknown = item;
    if (item && typeof item === 'object') {
      index = (item as { i?: unknown }).i;
      translation = (item as { t?: unknown }).t;
    }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > count) return null;
    if (result[index - 1] !== undefined) return null; // duplicate index
    if (typeof translation !== 'string') return null;
    // Drop a leaked list number ("3. ciao" for phrase 3).
    const cleaned = translation.replace(new RegExp(`^\\s*${index}[.)]\\s+`), '').trim();
    // An empty translation would silently delete source text.
    if (!cleaned) return null;
    result[index - 1] = cleaned;
  }
  return result as string[];
}

// ---------------------------------------------------------------------------
// Backend call
// ---------------------------------------------------------------------------

// Total time budget for one swap, across the first call and any retry.
// The spec requires results within 15 s; leave headroom for the response.
export const SWAP_DEADLINE_MS = 14_000;
// Don't start a retry unless at least this much of the budget remains.
const MIN_RETRY_MS = 4_000;
// Upstream error bodies can be large HTML pages or echo the prompt; log a slice.
const MAX_LOGGED_BODY_CHARS = 300;

// Output budget sized to the work: roughly one token per ~3 characters of
// Italian (which runs a little longer than English), plus JSON overhead per
// item, with generous headroom. Caps cost when a reply runs away.
export function maxTokensFor(spans: Span[]): number {
  const chars = spans.reduce((n, s) => n + s.text.length, 0);
  return Math.min(8192, Math.max(512, 256 + Math.ceil(chars * 0.75) + spans.length * 16));
}

function fallback(text: string): SwapResult {
  return { segments: [{ text, lang: 'source', translation: null }], degraded: true };
}

async function callModel(
  config: LlmConfig,
  userMessage: string,
  spans: Span[],
  timeoutMs: number,
): Promise<string[] | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.isOpenRouter) {
    headers['HTTP-Referer'] = 'https://aprendiendo-bilingue.vercel.app';
    headers['X-Title'] = 'Aprendiendo Bilingue';
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    max_tokens: maxTokensFor(spans),
  };
  if (config.structuredOutputs) {
    body.response_format = RESPONSE_FORMAT;
    // Only route to OpenRouter providers that actually enforce the schema.
    if (config.isOpenRouter) body.provider = { require_parameters: true };
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error('LLM error:', response.status, errorBody.slice(0, MAX_LOGGED_BODY_CHARS));
      return null;
    }

    const data = await response.json();
    const content: unknown = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) return null;

    return parseTranslations(content, spans.length);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`LLM call failed (${name}): ${message.slice(0, MAX_LOGGED_BODY_CHARS)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface SwapOptions {
  deadlineMs?: number;
  config?: LlmConfig;
}

export async function swap(text: string, level: Level, options: SwapOptions = {}): Promise<SwapResult> {
  const deadlineMs = options.deadlineMs ?? SWAP_DEADLINE_MS;
  const startedAt = Date.now();
  const remaining = () => deadlineMs - (Date.now() - startedAt);

  const config = options.config ?? loadLlmConfig();
  if (missingKey(config)) {
    console.error('LLM_API_KEY is not set — returning original text');
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

  let translations = await callModel(config, buildUserMessage(text, spans), spans, remaining());

  if (!translations) {
    if (remaining() < Math.min(MIN_RETRY_MS, deadlineMs / 3)) {
      console.error('No time left to retry — returning original text');
      return fallback(text);
    }
    console.warn(`Invalid translations for ${spans.length} phrases. Retrying.`);
    translations = await callModel(config, buildRetryMessage(text, spans), spans, remaining());
  }

  if (!translations) {
    console.error('Invalid translations after retry — returning original text');
    return fallback(text);
  }

  return { segments: reconstructSegments(text, spans, translations), degraded: false };
}
