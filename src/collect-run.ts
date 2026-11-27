import type { Logger } from "pino";
import type { Db } from "./db/client.js";
import { sources } from "./db/schema.js";
import { seedSources } from "./db/seed.js";
import { eq } from "drizzle-orm";
import { runCollector, type CollectorOptions, type SourceReport } from "./fetchers/collector.js";

export interface CollectDeps {
  db: Db;
  userId: number;
  configDir: string;
  fetchers: CollectorOptions["fetchers"];
  normalizer?: CollectorOptions["normalizer"];
  logger: Logger;
  now?: () => Date;
}

export interface CollectResult {
  exitCode: 0 | 1;
  summary: string;
  reports: SourceReport[];
}

/** Build the one-line summary of a run. */
export function formatSummary(reports: SourceReport[]): string {
  const count = (status: SourceReport["status"]) =>
    reports.filter((r) => r.status === status).length;
  const fetched = reports.reduce((sum, r) => sum + r.fetched, 0);
  const inserted = reports.reduce((sum, r) => sum + r.inserted, 0);
  return (
    `Collection done: sources ok ${count("ok")}, not modified ${count("not_modified")}, ` +
    `failed ${count("failed")}; items fetched ${fetched}, inserted ${inserted}`
  );
}

/**
 * Seed `sources` when the table is empty, then collect every due source.
 * Exit code 1 only when every due source failed. A database error propagates to the caller.
 */
export async function collect(deps: CollectDeps): Promise<CollectResult> {
  const { db, userId, logger } = deps;
  const existing = await db.$count(sources, eq(sources.userId, userId));
  if (existing === 0) {
    const seeded = await seedSources(db, deps.configDir, userId);
    logger.info({ seeded }, "Seeded empty sources table");
  }
  const reports = await runCollector({
    db,
    userId,
    fetchers: deps.fetchers,
    normalizer: deps.normalizer,
    logger,
    now: deps.now,
  });
  for (const report of reports) {
    if (report.status === "failed") {
      logger.warn({ source: report.slug, error: report.error }, "Source failed in this run");
    }
  }
  const summary = formatSummary(reports);
  const allFailed = reports.length > 0 && reports.every((r) => r.status === "failed");
  return { exitCode: allFailed ? 1 : 0, summary, reports };
}
