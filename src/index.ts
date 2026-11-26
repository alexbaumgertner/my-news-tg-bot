import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

function main(): void {
  const config = loadConfig();
  const logger = createLogger({ nodeEnv: config.env.NODE_ENV, level: config.env.LOG_LEVEL });
  logger.info({ sources: config.sources.length }, "Configuration loaded");
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
