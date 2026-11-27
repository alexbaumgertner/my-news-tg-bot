import { loadConfig } from "../src/config.js";
import { evaluateGolden, loadGoldenItems } from "../src/golden/eval.js";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import { pricingFromEnv } from "../src/llm/pricing.js";
import { createLogger } from "../src/logger.js";
import { loadProfileOrExample } from "../src/profile.js";

// Usage: pnpm golden:eval [--file tests/golden/items.jsonl] [--threshold 6]
// It calls the real API and costs money. The cost stops at LLM_DAILY_LIMIT_USD.
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const { env } = loadConfig();
if (!env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Cannot evaluate.");
  process.exit(1);
}
const threshold = Number(arg("threshold", "6"));
if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10) {
  console.error("--threshold must be an integer from 0 to 10.");
  process.exit(1);
}
const logger = createLogger({ nodeEnv: env.NODE_ENV, level: env.LOG_LEVEL });
const items = loadGoldenItems(arg("file", "tests/golden/items.jsonl"));
const report = await evaluateGolden({
  items,
  provider: new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }),
  profile: loadProfileOrExample(env.CONFIG_DIR, logger),
  model: env.LLM_MODEL,
  maxChars: env.SCORING_MAX_CHARS,
  maxOutputTokens: env.SCORING_MAX_OUTPUT_TOKENS,
  pricing: pricingFromEnv(env),
  keepThreshold: threshold,
  maxCostUsd: env.LLM_DAILY_LIMIT_USD,
});
const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
console.log(
  `Items ${report.evaluated}/${items.length}, invalid ${report.invalid}, cost $${report.costUsd.toFixed(4)}`,
);
console.log(
  `Keep precision ${pct(report.metrics.precision)}, recall ${pct(report.metrics.recall)}`,
);
if (report.skippedForCost > 0) {
  console.warn(`Warning: ${report.skippedForCost} items skipped because of the cost limit.`);
}
