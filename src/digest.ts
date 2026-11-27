import { parseArgs } from "node:util";
import { ConfigError, feedbackConfig, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { getSettings } from "./bot/settings.js";
import { withRetry } from "./digest/retry.js";
import { createGrammySender } from "./digest/sender.js";
import { runDigest } from "./digest/run.js";
import { createDbDigestStore } from "./digest/store.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { DIGEST_LANGUAGES, type DigestLanguage } from "./llm/compose-schema.js";
import { pricingFromEnv } from "./llm/pricing.js";
import { createDbScoringStore } from "./llm/score-store.js";
import { createLogger } from "./logger.js";
import type { DigestKind } from "./pipeline/rank.js";
import { loadProfileOrExample } from "./profile.js";

/** Hours of stories that a digest considers. Also the window of the footer counts. */
const WINDOW_HOURS = 24;

const USAGE = "Usage: pnpm digest --slot morning|evening [--dry-run]";

function parseCli(argv: string[]): { kind: DigestKind; dryRun: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: { slot: { type: "string" }, "dry-run": { type: "boolean", default: false } },
    strict: true,
  });
  if (values.slot !== "morning" && values.slot !== "evening") {
    throw new ConfigError(`--slot must be "morning" or "evening". ${USAGE}`);
  }
  return { kind: values.slot, dryRun: values["dry-run"] === true };
}

/** Build one digest for a slot, send it to the owner, and exit. */
async function main(): Promise<number> {
  const { kind, dryRun } = parseCli(process.argv.slice(2));
  const { env } = loadConfig();
  const logger = createLogger({ nodeEnv: env.NODE_ENV, level: env.LOG_LEVEL });
  const profile = loadProfileOrExample(env.CONFIG_DIR, logger);
  const { db, client } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    const settings = await getSettings(db, env.TELEGRAM_OWNER_ID);
    if (!(DIGEST_LANGUAGES as readonly string[]).includes(settings.language)) {
      throw new Error(`Digest language "${settings.language}" is not supported yet`);
    }
    const result = await runDigest({
      store: createDbDigestStore({
        db,
        userId: env.TELEGRAM_OWNER_ID,
        profile,
        windowHours: WINDOW_HOURS,
        feedback: feedbackConfig(env),
      }),
      sender: withRetry(createGrammySender(env.TELEGRAM_BOT_TOKEN), logger),
      usageStore: createDbScoringStore(db, env.TELEGRAM_OWNER_ID),
      provider: env.ANTHROPIC_API_KEY
        ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
        : null,
      logger,
      profile,
      kind,
      language: settings.language as DigestLanguage,
      timeZone: settings.timezone,
      // A private chat has the same id as the user.
      chatId: settings.chatId ?? env.TELEGRAM_OWNER_ID,
      dryRun,
      print: (text) => console.log(text),
      windowHours: WINDOW_HOURS,
      model: env.LLM_MODEL,
      maxChars: env.SCORING_MAX_CHARS,
      maxOutputTokens: env.COMPOSE_MAX_OUTPUT_TOKENS,
      pricing: pricingFromEnv(env),
      dailyLimitUsd: env.LLM_DAILY_LIMIT_USD,
      monthlyLimitUsd: env.LLM_MONTHLY_LIMIT_USD,
    });
    const summary = `Digest ${kind}: ${result.status}, ${result.stories} stories, ${result.messages} messages${result.degraded ? " (degraded)" : ""}`;
    logger.info(result, "Digest run finished");
    console.log(summary);
    return 0;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Digest failed",
    );
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
