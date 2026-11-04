// Backend configuration for the swap engine's LLM.
//
// Any OpenAI-compatible /chat/completions endpoint works: OpenRouter (default),
// or a local server such as Ollama or vLLM. Switching is configuration only:
//
//   LLM_BASE_URL=http://localhost:11434/v1   # no key needed for local servers
//   LLM_MODEL=gemma4:26b
//
// The older OPENROUTER_* variable names are still read as fallbacks.

export const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  // Ask the backend to enforce our JSON schema (response_format: json_schema).
  structuredOutputs: boolean;
  isOpenRouter: boolean;
}

type Env = Record<string, string | undefined>;

function read(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const baseUrl = (read(env, 'LLM_BASE_URL', 'OPENROUTER_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let isOpenRouter = false;
  try {
    isOpenRouter = new URL(baseUrl).hostname.endsWith('openrouter.ai');
  } catch {
    // Invalid URL: the request will fail and the engine will degrade gracefully.
  }
  return {
    baseUrl,
    model: read(env, 'LLM_MODEL', 'OPENROUTER_MODEL') ?? DEFAULT_MODEL,
    apiKey: read(env, 'LLM_API_KEY', 'OPENROUTER_API_KEY'),
    structuredOutputs: read(env, 'LLM_STRUCTURED_OUTPUTS')?.toLowerCase() !== 'false',
    isOpenRouter,
  };
}

// Hosted OpenRouter needs a key; local servers usually don't.
export function missingKey(config: LlmConfig): boolean {
  return config.isOpenRouter && !config.apiKey;
}
