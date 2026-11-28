import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FeedbackConfig } from "./feedback/rules.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().min(1),
  // Optional on purpose: without a key, scoring logs an error and is skipped (SPEC section 4).
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  LLM_DAILY_LIMIT_USD: z.coerce.number().positive().default(0.16),
  LLM_MONTHLY_LIMIT_USD: z.coerce.number().positive().default(5),
  // Prices in USD per million tokens. Check them against the Anthropic price list for LLM_MODEL.
  LLM_PRICE_INPUT_PER_MTOK: z.coerce.number().min(0).default(1),
  LLM_PRICE_OUTPUT_PER_MTOK: z.coerce.number().min(0).default(5),
  LLM_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().min(0).default(0.1),
  LLM_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().min(0).default(1.25),
  // The Batch API costs this fraction of the normal price.
  LLM_BATCH_PRICE_FACTOR: z.coerce.number().gt(0).max(1).default(0.5),
  SCORING_MODE: z.enum(["batch", "sync"]).default("batch"),
  SCORING_DAILY_CAP: z.coerce.number().int().min(0).default(100),
  SCORING_MAX_CHARS: z.coerce.number().int().min(100).max(20_000).default(1500),
  SCORING_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(4000).default(500),
  COMPOSE_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(200).max(4000).default(800),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_API_URL: z.string().url().default("https://api.voyageai.com/v1/embeddings"),
  EMBEDDINGS_MODEL: z.string().min(1).default("voyage-3.5"),
  DEDUP_SIMILARITY_THRESHOLD: z.coerce.number().gt(0).max(1).default(0.88),
  DEDUP_WINDOW_HOURS: z.coerce.number().positive().max(720).default(48),
  // Items older than this many days (by effective time) are not embedded or clustered.
  ITEM_MAX_AGE_DAYS: z.coerce.number().positive().max(3650).default(7),
  PREFILTER_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.4),
  PREFILTER_WEIGHT_DISCOUNT: z.coerce.number().min(0).max(1).default(0.05),
  // Feedback: each vote moves a multiplier by this fraction. The multipliers stay in the bounds.
  FEEDBACK_STEP: z.coerce.number().gt(0).max(0.25).default(0.05),
  FEEDBACK_TOPIC_MIN: z.coerce.number().gt(0).max(1).default(0.5),
  FEEDBACK_TOPIC_MAX: z.coerce.number().min(1).max(5).default(1.5),
  FEEDBACK_SOURCE_MIN: z.coerce.number().gt(0).max(1).default(0.5),
  FEEDBACK_SOURCE_MAX: z.coerce.number().min(1).max(5).default(1.5),
  HTTP_USER_AGENT: z.string().min(1).default("my-news-tg-bot/0.1"),
  NCBI_API_KEY: z.string().optional(),
  HN_MIN_SCORE: z.coerce.number().int().min(0).default(100),
  CONFIG_DIR: z.string().min(1).default("./config"),
});

export type Env = z.infer<typeof envSchema>;

/** The feedback step and bounds from the environment. */
export function feedbackConfig(env: Env): FeedbackConfig {
  return {
    step: env.FEEDBACK_STEP,
    topicMin: env.FEEDBACK_TOPIC_MIN,
    topicMax: env.FEEDBACK_TOPIC_MAX,
    sourceMin: env.FEEDBACK_SOURCE_MIN,
    sourceMax: env.FEEDBACK_SOURCE_MAX,
  };
}

export const sourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["rss", "arxiv", "pubmed", "clinicaltrials", "hn", "telegram_web", "html"]),
  url: z.string().url(),
  language: z.string().length(2),
  topics: z.array(z.string()).default([]),
  trust: z.number().int().min(1).max(5),
  poll_interval: z.string().regex(/^\d+[mhd]$/, "use a number and a unit, for example 2h"),
  active: z.boolean(),
  verified: z.boolean().optional(),
  notes: z.string().optional(),
  initial_lookback_days: z.number().int().min(1).max(3650).optional(),
});

export const sourcesFileSchema = z.object({ sources: z.array(sourceSchema) });

export type Source = z.infer<typeof sourceSchema>;

export interface AppConfig {
  env: Env;
  sources: Source[];
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  // Treat empty strings as unset, so `FOO=` in .env uses the default or fails clearly.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      `Invalid environment variables:\n${formatIssues(result.error)}\nSee .env.example.`,
    );
  }
  return result.data;
}

export function loadYamlFile<T>(path: string, schema: z.ZodType<T>): T {
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot parse YAML in ${path}: ${(error as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`Invalid config in ${path}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export function loadConfig(raw: Record<string, string | undefined> = process.env): AppConfig {
  loadDotenv({ quiet: true });
  const env = parseEnv({ ...raw });
  const sources = loadYamlFile(join(env.CONFIG_DIR, "sources.yaml"), sourcesFileSchema).sources;
  return { env, sources };
}
