import type { Level, Span, SwapResult } from './types';
import { selectSpans } from './tagger';
import { reconstructSegments } from './segmenter';
import { loadLlmConfig, missingKey, type LlmConfig } from './llmConfig';
import { Diagnostics } from './diagnostics';
import { chunkText, type TextRange } from './chunker';
import { runChunks, type AttemptKind, type ChunkFailure, type ChunkOutcome } from './chunkRunner';
import { classifyLlmError } from './llmErrors';

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

// Total time budget for one swap, across all calls and any retries.
// The spec requires results within 15 s; leave headroom for the response.
export const SWAP_DEADLINE_MS = 14_000;
// Don't start a retry unless at least this much of the budget remains.
const MIN_RETRY_MS = 4_000;
// If a chunk's request hasn't answered after this long, send a second request
// alongside it (a hedge) and keep whichever valid reply arrives first. The
// slow request is not cancelled: a reply at 9-13 s still counts, as before.
export const HEDGE_AFTER_MS = 8_000;
// Extra requests (retries + hedges) across all chunks of one request.
const MAX_CHUNK_RETRIES = 2;

// Long texts are split into chunks translated in parallel: one serial call
// can't produce several thousand output tokens inside the deadline.
// Estimated output tokens per chunk (see phraseTokens). Texts under this are
// sent as a single call, exactly as before chunking existed.
//
// Tuned live (Nov 2026, Gemma 4 26B): real output is ~0.85-0.9x the
// estimate; on the providers in PROVIDER_ORDER a 400-estimate chunk (~350
// real tokens) takes ~1.5-5 s, well inside HEDGE_AFTER_MS.
export const CHUNK_TARGET_TOKENS = 400;
// At the 12,000-char cap Level 1 estimates ~7.1-8.5K tokens: 20 chunks keeps
// them at ~360-430. Each call resends the full text (~3.3K input tokens), so a
// capped request costs ~$0.006 (Makora) to ~$0.012 (Parasail), more if hedged.
export const MAX_CHUNKS = 20;

// Estimated output tokens for one phrase: JSON item overhead plus the
// translation. Measured ~11 tokens per Level 1 phrase on Gemma 4.
export function phraseTokens(span: Span): number {
  return 9 + Math.ceil(span.text.length / 3);
}

// OpenRouter routing: try these providers first, in order, then fall back to
// any other (allow_fallbacks), so routing never fails if they're down. Default
// routing is price-weighted and picks slow endpoints: live, the same 40-phrase
// chunk took 1.35 s on Makora vs 15.8 s on PrimeIntellect, and a 33-phrase
// chunk took 25.5 s on Darkbloom (Nov 2026, google/gemma-4-26b-a4b-it).
// All three support structured outputs.
export const PROVIDER_ORDER = ['makora', 'parasail', 'nextbit'];

// Which providers to try, and in what order, for one request. Chunks alternate
// their first provider so one slow provider can't stall every chunk, and a
// hedge or a retry after a timeout/5xx avoids the provider the first request
// went to (it is the likeliest culprit).
export function providerRouting(chunkIndex: number, avoidFirst: boolean): { order: string[]; ignore?: string[] } {
  const primary = chunkIndex % 2 === 0 ? PROVIDER_ORDER : [PROVIDER_ORDER[1], PROVIDER_ORDER[0], ...PROVIDER_ORDER.slice(2)];
  if (!avoidFirst) return { order: primary };
  return { order: primary.slice(1), ignore: [primary[0]] };
}

// Models where `reasoning: {enabled: false}` is safe to send. Reasoning-only
// models reject it with a 400, so it's sent only for these. Gemma 4 lists
// reasoning as optional and off by default (OpenRouter get-model).
function canDisableReasoning(model: string): boolean {
  // Gemma 3 and 2 don't list `reasoning` as a supported parameter, and
  // require_parameters would then find no endpoint.
  return model.startsWith('google/gemma-4-');
}
// Upstream error bodies can be large HTML pages or echo the prompt; log a slice.
const MAX_LOGGED_BODY_CHARS = 300;

// Output budget sized to the work: roughly one token per ~3 characters of
// Italian (which runs a little longer than English), plus JSON overhead per
// item, with generous headroom. Caps cost when a reply runs away.
export function maxTokensFor(spans: Span[]): number {
  const chars = spans.reduce((n, s) => n + s.text.length, 0);
  return Math.min(8192, Math.max(512, 256 + Math.ceil(chars * 0.75) + spans.length * 16));
}

function fallback(text: string, diag: Diagnostics): SwapResult {
  return { segments: [{ text, lang: 'source', translation: null }], degraded: true, debug: diag.events };
}

function describeBackend(config: LlmConfig): string {
  let host = config.baseUrl;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    // Show the raw value; the call will fail and say why.
  }
  return `model ${config.model} via ${host}`;
}

/**
 * The chat-completions body for one call. `text` is always the whole input
 * text (the model needs it for agreement); `spans` are only the phrases this
 * call translates. `retryPrompt` adds the stricter instructions, used after
 * the model returned an unusable reply.
 */
export function buildRequestBody(
  config: LlmConfig,
  text: string,
  spans: Span[],
  retryPrompt = false,
  // 0-based position among the chunks of this request; selects the provider order.
  chunkIndex = 0,
  // Hedge, or retry after a timeout/5xx: steer away from the first provider.
  avoidFirstProvider = false,
): Record<string, unknown> {
  const userMessage = retryPrompt ? buildRetryMessage(text, spans) : buildUserMessage(text, spans);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    max_tokens: maxTokensFor(spans),
  };
  if (config.structuredOutputs) body.response_format = RESPONSE_FORMAT;
  if (config.isOpenRouter) {
    body.provider = {
      // Only route to providers that actually enforce the schema.
      ...(config.structuredOutputs ? { require_parameters: true } : {}),
      ...providerRouting(chunkIndex, avoidFirstProvider),
      allow_fallbacks: true,
    };
    // Say so explicitly so a provider default can't spend the deadline on
    // thinking tokens.
    if (canDisableReasoning(config.model)) body.reasoning = { enabled: false };
  }
  return body;
}

function fail(reason: string, extra: Partial<Omit<ChunkFailure, 'ok' | 'reason'>> = {}): ChunkFailure {
  const failure: ChunkFailure = { ok: false, reason, retryable: extra.retryable ?? true };
  if (extra.retryAfterMs !== undefined) failure.retryAfterMs = extra.retryAfterMs;
  if (extra.invalidReply) failure.invalidReply = true;
  return failure;
}

async function callModel(
  config: LlmConfig,
  body: Record<string, unknown>,
  count: number,
  timeoutMs: number,
  signal: AbortSignal,
  diag: Diagnostics,
  attempt: string,
): Promise<ChunkOutcome<string[]>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.isOpenRouter) {
    headers['HTTP-Referer'] = 'https://aprendiendo-bilingue.vercel.app';
    headers['X-Title'] = 'Aprendiendo Bilingue';
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      diag.error(
        `${attempt}: LLM error ${response.status} from ${config.model}`,
        errorBody.slice(0, MAX_LOGGED_BODY_CHARS),
      );
      const kind = classifyLlmError(response.status, errorBody, response.headers.get('retry-after'));
      const after = kind.retryAfterMs === undefined ? '' : `, Retry-After ${Math.round(kind.retryAfterMs / 1000)} s`;
      if (kind.kind === 'rate_limited') return fail(`rate limited (429${after})`, { retryable: false });
      if (kind.kind === 'spend_limit') {
        return fail(`spend limit reached (${kind.limitSource ?? `HTTP ${response.status}`})`, { retryable: false });
      }
      if (kind.kind === 'in_flight_budget') return fail(`in-flight budget full${after}`, { retryAfterMs: kind.retryAfterMs });
      return fail(`LLM error ${response.status}`);
    }

    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      diag.error(`${attempt}: LLM returned a non-JSON response`, raw.slice(0, MAX_LOGGED_BODY_CHARS));
      return fail('non-JSON response');
    }
    const content: unknown = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
      ?.content;
    if (typeof content !== 'string' || !content) {
      diag.error(`${attempt}: LLM reply had no message content`, raw.slice(0, MAX_LOGGED_BODY_CHARS));
      return fail('no message content');
    }

    const translations = parseTranslations(content, count);
    if (!translations) {
      diag.error(
        `${attempt}: couldn't use the model's reply (expected ${count} numbered translations)`,
        content.slice(0, MAX_LOGGED_BODY_CHARS),
      );
      return fail('unusable reply', { invalidReply: true });
    }
    return { ok: true, value: translations };
  } catch (err) {
    // Aborted by the runner because the other request for this chunk won.
    if (signal.aborted) return fail('cancelled', { retryable: false });
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    const reason = name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : `failed (${name})`;
    diag.error(`${attempt}: LLM call ${reason}`, message.slice(0, MAX_LOGGED_BODY_CHARS));
    // A capped first attempt that timed out is worth retrying if time remains;
    // the runner checks the remaining budget.
    return fail(`LLM call ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface ChunkJob {
  index: number; // 1-based, among chunks that have phrases
  spans: Span[];
}

const formatMs = (ms: number) => ms.toLocaleString('en-US');

/** Groups spans (sorted, global offsets) into per-chunk jobs. */
export function planChunks(text: string, spans: Span[]): Span[][] {
  // Prefix sums of estimated tokens by span start, so a range's weight is two
  // binary searches.
  const starts = spans.map((s) => s.start);
  const prefix = [0];
  for (const span of spans) prefix.push(prefix[prefix.length - 1] + phraseTokens(span));
  const firstAtOrAfter = (position: number) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const weight = (r: TextRange) => prefix[firstAtOrAfter(r.end)] - prefix[firstAtOrAfter(r.start)];

  const chunks = chunkText(text, {
    locale: 'en',
    target: CHUNK_TARGET_TOKENS,
    maxChunks: MAX_CHUNKS,
    weight,
    protect: spans,
  });

  // Each span belongs to the chunk containing its start. `protect` keeps spans
  // from crossing a chunk end, and chunks tile the text, so this is a partition.
  const groups: Span[][] = [];
  let next = 0;
  for (const chunk of chunks) {
    const group: Span[] = [];
    while (next < spans.length && spans[next].start < chunk.end) group.push(spans[next++]);
    if (group.length > 0) groups.push(group);
  }
  return groups;
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

  const diag = new Diagnostics();
  const config = options.config ?? loadLlmConfig();
  if (missingKey(config)) {
    diag.error('LLM_API_KEY is not set — returning original text');
    return fallback(text, diag);
  }

  let spans: Span[];
  try {
    spans = selectSpans(text, level);
  } catch (err) {
    diag.error('Tagger error — returning original text', err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fallback(text, diag);
  }
  // Nothing worth swapping (e.g. only names and numbers): not a failure.
  if (spans.length === 0) {
    diag.info(`Level ${level}: no phrases selected to swap`);
    return { segments: [{ text, lang: 'source', translation: null }], degraded: false, debug: diag.events };
  }
  if (config.model.endsWith(':free')) {
    diag.warn(`${config.model} is a free model with a per-minute request cap; long texts make up to ${MAX_CHUNKS} calls`);
  }

  const jobs: ChunkJob[] = planChunks(text, spans).map((group, i) => ({ index: i + 1, spans: group }));
  const n = jobs.length;
  if (n === 1) {
    diag.info(`Level ${level}: ${spans.length} phrases → ${describeBackend(config)}`);
  } else {
    const tokens = spans.reduce((sum, s) => sum + phraseTokens(s), 0);
    diag.info(
      `Level ${level}: ${spans.length} phrases in ${n} chunks (~${Math.round(tokens / n)} tokens each) → ${describeBackend(config)}`,
    );
  }

  // A single chunk keeps the pre-chunking wording ("Attempt 1", "Retrying 3 phrases").
  const label = (job: ChunkJob) => (n === 1 ? `${job.spans.length} phrases` : `Chunk ${job.index}/${n}`);
  const attemptLabel = (job: ChunkJob, attempt: number) =>
    n === 1 ? `Attempt ${attempt}` : `${label(job)} · attempt ${attempt}`;

  const results = await runChunks(
    jobs,
    (job, attempt, timeoutMs, signal, previous, kind: AttemptKind = 'first') =>
      callModel(
        config,
        // The stricter prompt only helps when the model answered badly; after a
        // timeout or a 5xx (or for a hedge) the normal prompt is right, and
        // the request goes to a different provider than the first one.
        buildRequestBody(
          config,
          text,
          job.spans,
          previous?.invalidReply === true,
          n === 1 ? 0 : job.index - 1,
          kind === 'hedge' || (kind === 'retry' && previous?.invalidReply !== true),
        ),
        job.spans.length,
        timeoutMs,
        signal,
        diag,
        attemptLabel(job, attempt),
      ),
    {
      remaining,
      hedgeAfterMs: HEDGE_AFTER_MS,
      maxRetries: MAX_CHUNK_RETRIES,
      minRetryMs: Math.min(MIN_RETRY_MS, deadlineMs / 3),
      diag,
      label,
    },
  );

  const keptSpans: Span[] = [];
  const translations: string[] = [];
  let failedChunks = 0;
  let failedPhrases = 0;
  results.forEach((result, i) => {
    const job = jobs[i];
    if (result.value) {
      keptSpans.push(...job.spans);
      translations.push(...result.value);
      if (n > 1) diag.info(`${label(job)}: ${job.spans.length} phrases in ${formatMs(result.ms)} ms`);
    } else {
      failedChunks++;
      failedPhrases += job.spans.length;
    }
  });

  if (failedChunks === n) {
    diag.error('No usable translations — returning original text');
    return fallback(text, diag);
  }

  const partial = failedChunks > 0;
  if (partial) {
    diag.warn(
      `Partial result: ${failedChunks} of ${n} chunks (${failedPhrases} of ${spans.length} phrases) shown as original text`,
    );
  }
  const elapsed = Date.now() - startedAt;
  diag.info(n === 1 ? `Done in ${elapsed} ms` : `Done in ${formatMs(elapsed)} ms (${n} chunks${partial ? ', partial' : ''})`);

  const result: SwapResult = {
    segments: reconstructSegments(text, keptSpans, translations),
    degraded: false,
    debug: diag.events,
  };
  if (partial) result.partial = true;
  return result;
}
