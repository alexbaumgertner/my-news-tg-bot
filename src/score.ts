import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { pricingFromEnv } from "./llm/pricing.js";
import { runScoring } from "./llm/score.js";
import { createDbScoringStore } from "./llm/score-store.js";
import { createLogger } from "./logger.js";
import { loadProfileOrExample } from "./profile.js";

/** Score the stories that passed the pre-filter, once, and exit. */
async function main(): Promise<number> {
  const { env } = loadConfig();
  const logger = createLogger({ nodeEnv: env.NODE_ENV, level: env.LOG_LEVEL });
  const profile = loadProfileOrExample(env.CONFIG_DIR, logger);
  const { db, client } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    const report = await runScoring({
      store: createDbScoringStore(db, env.TELEGRAM_OWNER_ID),
      provider: env.ANTHROPIC_API_KEY
        ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
        : null,
      logger,
      profile,
      model: env.LLM_MODEL,
      mode: env.SCORING_MODE,
      dailyCap: env.SCORING_DAILY_CAP,
      dailyLimitUsd: env.LLM_DAILY_LIMIT_USD,
      monthlyLimitUsd: env.LLM_MONTHLY_LIMIT_USD,
      maxChars: env.SCORING_MAX_CHARS,
      maxOutputTokens: env.SCORING_MAX_OUTPUT_TOKENS,
      pricing: pricingFromEnv(env),
    });
    logger.info(report, "Scoring finished");
    // A missing key is a skip, not a crash.
    return 0;
  } catch (error) {
    logger.error({ err: error }, "Scoring failed");
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
