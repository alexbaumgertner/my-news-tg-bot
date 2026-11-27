import { createBot, startBot } from "./bot/bot.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ nodeEnv: config.env.NODE_ENV, level: config.env.LOG_LEVEL });
  logger.info({ sources: config.sources.length }, "Configuration loaded");

  const { db, client } = createDb(config.env.DATABASE_URL);
  const bot = createBot({
    token: config.env.TELEGRAM_BOT_TOKEN,
    ownerId: config.env.TELEGRAM_OWNER_ID,
    db,
  });
  bot.catch((err) => logger.error({ err: err.error }, "Bot error"));

  const stop = async (): Promise<void> => {
    await bot.stop();
    await client.end();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await startBot(bot, () => logger.info("Bot started (long polling)"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
});
