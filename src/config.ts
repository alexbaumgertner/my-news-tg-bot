import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  LLM_DAILY_LIMIT_USD: z.coerce.number().positive().default(0.16),
  LLM_MONTHLY_LIMIT_USD: z.coerce.number().positive().default(5),
  EMBEDDINGS_API_KEY: z.string().optional(),
  HTTP_USER_AGENT: z.string().min(1).default("my-news-tg-bot/0.1"),
  NCBI_API_KEY: z.string().optional(),
  HN_MIN_SCORE: z.coerce.number().int().min(0).default(100),
  CONFIG_DIR: z.string().min(1).default("./config"),
});

export type Env = z.infer<typeof envSchema>;

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
