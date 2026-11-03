import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadLlmConfig, missingKey } from './llmConfig';

describe('loadLlmConfig', () => {
  it('defaults to Gemma 4 on OpenRouter', () => {
    const config = loadLlmConfig({});
    expect(config).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: DEFAULT_MODEL,
      structuredOutputs: true,
      isOpenRouter: true,
    });
    expect(DEFAULT_MODEL).toBe('google/gemma-4-26b-a4b-it');
    expect(missingKey(config)).toBe(true);
  });

  it('prefers LLM_* names and falls back to OPENROUTER_*', () => {
    expect(loadLlmConfig({ OPENROUTER_API_KEY: 'old', OPENROUTER_MODEL: 'm1' })).toMatchObject({ apiKey: 'old', model: 'm1' });
    expect(loadLlmConfig({ LLM_API_KEY: 'new', OPENROUTER_API_KEY: 'old' }).apiKey).toBe('new');
  });

  it('does not require a key for a local server', () => {
    const config = loadLlmConfig({ LLM_BASE_URL: 'http://localhost:11434/v1' });
    expect(config.isOpenRouter).toBe(false);
    expect(missingKey(config)).toBe(false);
  });

  it('treats blank values as unset', () => {
    expect(loadLlmConfig({ LLM_MODEL: '  ', LLM_API_KEY: '' })).toMatchObject({ model: DEFAULT_MODEL, apiKey: undefined });
  });
});
