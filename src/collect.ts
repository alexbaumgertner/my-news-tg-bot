import { collect } from "./collect-run.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { ArxivFetcher } from "./fetchers/arxiv.js";
import { HnFetcher } from "./fetchers/hn.js";
import { PubmedFetcher } from "./fetchers/pubmed.js";
import { RssFetcher } from "./fetchers/rss.js";
import { TelegramWebFetcher } from "./fetchers/telegram-web.js";
import { createLogger } from "./logger.js";
import { Normalizer } from "./pipeline/normalize.js";

/** Collect all due sources once and exit. Run it by hand or from a timer. */
async function main(): Promise<number> {
  const config = loadConfig();
  const { env } = config;
  const logger = createLogger({ nodeEnv: env.NODE_ENV, level: env.LOG_LEVEL });
  const http = { userAgent: env.HTTP_USER_AGENT };
  const { db, client } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    const result = await collect({
      db,
      userId: env.TELEGRAM_OWNER_ID,
      configDir: env.CONFIG_DIR,
      fetchers: {
        rss: new RssFetcher(http),
        arxiv: new ArxivFetcher({ http }),
        hn: new HnFetcher({ http, minScore: env.HN_MIN_SCORE }),
        pubmed: new PubmedFetcher({ http, apiKey: env.NCBI_API_KEY }),
        telegram_web: new TelegramWebFetcher({ http }),
      },
      normalizer: new Normalizer({ userAgent: env.HTTP_USER_AGENT }),
      logger,
    });
    logger.info(result.summary);
    console.log(result.summary);
    return result.exitCode;
  } catch (error) {
    logger.error({ err: error }, "Collection failed: database error");
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
