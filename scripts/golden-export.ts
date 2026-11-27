import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { loadYamlFile, sourcesFileSchema } from "../src/config.js";
import { collectCandidates } from "../src/golden/collect.js";
import { formatCandidatesCsv } from "../src/golden/export.js";
import { createLogger } from "../src/logger.js";

loadDotenv({ quiet: true });

const { values } = parseArgs({
  options: {
    "per-source": { type: "string", default: "3" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "tmp/golden/candidates.csv" },
  },
});

function positiveInt(name: string, value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    console.error(`--${name} must be a non-negative integer.`);
    process.exit(1);
  }
  return number;
}

const perSource = positiveInt("per-source", values["per-source"]);
const seed = positiveInt("seed", values.seed);
const out = values.out ?? "tmp/golden/candidates.csv";
const logger = createLogger({ nodeEnv: "production", level: process.env.LOG_LEVEL ?? "info" });

const configDir = process.env.CONFIG_DIR || "./config";
const sources = loadYamlFile(join(configDir, "sources.yaml"), sourcesFileSchema).sources;
const rows = await collectCandidates({
  sources,
  perSource,
  seed,
  userAgent: process.env.HTTP_USER_AGENT || "my-news-tg-bot/0.1",
  ncbiApiKey: process.env.NCBI_API_KEY || undefined,
  hnMinScore: Number(process.env.HN_MIN_SCORE) || 100,
  logger,
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, formatCandidatesCsv(rows), "utf8");
logger.info({ out, items: rows.length }, "Candidates written");
