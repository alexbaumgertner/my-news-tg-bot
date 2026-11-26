import { pino, type Logger } from "pino";

export function createLogger(options: { nodeEnv: string; level: string }): Logger {
  const isDev = options.nodeEnv === "development";
  return pino({
    level: options.level,
    ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
