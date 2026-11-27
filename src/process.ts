import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { pricingFromEnv } from "./llm/pricing.js";
import { createLogger } from "./logger.js";
import { clusterOptionsFromEnv } from "./pipeline/dedup.js";
import { createHostedEmbeddingsClient } from "./pipeline/embeddings.js";
import { prefilterOptionsFromEnv } from "./pipeline/prefilter.js";
import { runProcess } from "./process-run.js";
import { loadProfileOrExample } from "./profile.js";

/** Dedup, pre-filter and score new stories once, then exit. */
async function main(): Promise<number> {
  const { env } = loadConfig();
  const logger = createLogger({ nodeEnv: env.NODE_ENV, level: env.LOG_LEVEL });
  const profile = loadProfileOrExample(env.CONFIG_DIR, logger);
  const { db, client } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    const report = await runProcess({
      db,
      userId: env.TELEGRAM_OWNER_ID,
      logger,
      profile,
      embeddings: env.EMBEDDINGS_API_KEY
        ? createHostedEmbeddingsClient({
            apiKey: env.EMBEDDINGS_API_KEY,
            url: env.EMBEDDINGS_API_URL,
            model: env.EMBEDDINGS_MODEL,
            userAgent: env.HTTP_USER_AGENT,
          })
        : null,
      cluster: clusterOptionsFromEnv(env),
      prefilter: prefilterOptionsFromEnv(env),
      scoring: {
        provider: env.ANTHROPIC_API_KEY
          ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
          : null,
        model: env.LLM_MODEL,
        mode: env.SCORING_MODE,
        dailyCap: env.SCORING_DAILY_CAP,
        dailyLimitUsd: env.LLM_DAILY_LIMIT_USD,
        monthlyLimitUsd: env.LLM_MONTHLY_LIMIT_USD,
        maxChars: env.SCORING_MAX_CHARS,
        maxOutputTokens: env.SCORING_MAX_OUTPUT_TOKENS,
        pricing: pricingFromEnv(env),
      },
    });
    console.log(
      `Process: embedded ${report.dedup.embedded}, clustered ${report.dedup.clustered} (${report.dedup.newStories} new stories), ` +
        `pre-filter passed ${report.prefilter.passed} / dropped ${report.prefilter.dropped}, ` +
        `scored ${report.scoring.scored}, invalid ${report.scoring.invalid}, failed ${report.scoring.failed}` +
        (report.scoring.status === "no_api_key" ? " (scoring skipped: no ANTHROPIC_API_KEY)" : ""),
    );
    return 0;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Processing failed",
    );
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
