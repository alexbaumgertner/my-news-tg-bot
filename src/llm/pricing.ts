import type { LlmUsage } from "./provider.js";

/** Prices in USD per million tokens. They come from config. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** The Batch API costs this fraction of the normal price. */
  batchFactor: number;
}

export function pricingFromEnv(env: {
  LLM_PRICE_INPUT_PER_MTOK: number;
  LLM_PRICE_OUTPUT_PER_MTOK: number;
  LLM_PRICE_CACHE_READ_PER_MTOK: number;
  LLM_PRICE_CACHE_WRITE_PER_MTOK: number;
  LLM_BATCH_PRICE_FACTOR: number;
}): Pricing {
  return {
    inputPerMTok: env.LLM_PRICE_INPUT_PER_MTOK,
    outputPerMTok: env.LLM_PRICE_OUTPUT_PER_MTOK,
    cacheReadPerMTok: env.LLM_PRICE_CACHE_READ_PER_MTOK,
    cacheWritePerMTok: env.LLM_PRICE_CACHE_WRITE_PER_MTOK,
    batchFactor: env.LLM_BATCH_PRICE_FACTOR,
  };
}

/** Cost in USD of one answer. */
export function costUsd(usage: LlmUsage, pricing: Pricing, batch: boolean): number {
  const total =
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok) /
    1_000_000;
  return batch ? total * pricing.batchFactor : total;
}

/** Characters per token used for the estimate. Low on purpose, so the estimate is high. */
const CHARS_PER_TOKEN = 2.5;

/**
 * Upper estimate of the cost of one request, before it is sent.
 * The system text counts at the cache-read price. The real cost is recorded after the call.
 */
export function estimateCostUsd(
  pricing: Pricing,
  sizes: { systemChars: number; userChars: number; maxOutputTokens: number },
  batch: boolean,
): number {
  return costUsd(
    {
      inputTokens: Math.ceil(sizes.userChars / CHARS_PER_TOKEN),
      outputTokens: sizes.maxOutputTokens,
      cacheReadTokens: Math.ceil(sizes.systemChars / CHARS_PER_TOKEN),
      cacheWriteTokens: 0,
    },
    pricing,
    batch,
  );
}
