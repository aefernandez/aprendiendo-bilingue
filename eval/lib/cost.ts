// Cost estimation for planned eval calls.
//
// Prices are a hard-coded table (USD per million tokens) and are flagged as
// stale in every estimate: check https://openrouter.ai/<model> before a large
// run. Actual spend is taken from `usage.cost` in each response when present.

import { DEFAULT_MODEL } from '../../lib/llmConfig';

/** The model the engine will actually call in an eval worker; plan items should use it. */
export function evalModel(env: Record<string, string | undefined> = process.env): string {
  return env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

export interface Price {
  inputPerM: number;
  outputPerM: number;
}

export const PRICES_AS_OF = '2026-11-04';

export const PRICES: Record<string, Price> = {
  'google/gemma-4-26b-a4b-it': { inputPerM: 0.032, outputPerM: 0.097 },
  'anthropic/claude-haiku-5.5': { inputPerM: 0.1, outputPerM: 0.5 },
};

// Used for an unknown model so that estimates err on the high side.
export const FALLBACK_PRICE: Price = { inputPerM: 2, outputPerM: 10 };

export interface TokenEstimate {
  promptTokens: number;
  completionTokens: number;
}

export interface PlannedCall extends TokenEstimate {
  model: string;
}

export interface CostEstimate {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  /** Always true for the hard-coded table; true reminds the owner to check live prices. */
  stale: boolean;
  unknownModels: string[];
}

/** Rough token count: ~3.5 characters per token, rounded up (errs high for en/es). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function priceFor(model: string): Price | undefined {
  return PRICES[model];
}

export function callCost(model: string, tokens: TokenEstimate): number {
  const price = priceFor(model) ?? FALLBACK_PRICE;
  return (tokens.promptTokens * price.inputPerM + tokens.completionTokens * price.outputPerM) / 1e6;
}

export function estimateCost(calls: PlannedCall[]): CostEstimate {
  const unknown = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let usd = 0;
  for (const c of calls) {
    if (!priceFor(c.model)) unknown.add(c.model);
    promptTokens += c.promptTokens;
    completionTokens += c.completionTokens;
    usd += callCost(c.model, c);
  }
  return { calls: calls.length, promptTokens, completionTokens, usd, stale: true, unknownModels: [...unknown] };
}

export function formatUsd(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
