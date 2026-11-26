import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { items, sources } from "../db/schema.js";
import { canonicalizeUrl, contentHash } from "./normalize.js";
import type { Fetcher } from "./types.js";

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** Overlap when we ask a feed for items "since" the last success. Dedup removes repeats. */
const SINCE_MARGIN_MS = UNIT_MS.d;

/** Convert a poll interval such as "2h" to milliseconds. */
export function parsePollInterval(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) throw new Error(`Invalid poll interval: ${value}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export interface SourceReport {
  slug: string;
  status: "ok" | "not_modified" | "failed";
  fetched: number;
  inserted: number;
  error?: string;
}

export interface CollectorOptions {
  db: Db;
  userId: number;
  fetchers: Record<string, Fetcher>;
  logger: Logger;
  now?: () => Date;
}

/**
 * Fetch every active source that is due and store new raw items.
 * A failing source is recorded and skipped. It never stops the run.
 */
export async function runCollector(options: CollectorOptions): Promise<SourceReport[]> {
  const { db, userId, fetchers, logger } = options;
  const now = options.now ?? (() => new Date());
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.active, true)));

  const reports: SourceReport[] = [];
  for (const row of rows) {
    const fetcher = fetchers[row.type];
    if (!fetcher) continue;
    const started = now();
    let interval: number;
    try {
      interval = parsePollInterval(row.pollInterval);
    } catch (error) {
      logger.warn({ source: row.slug, err: error }, "Skipping source with invalid poll interval");
      continue;
    }
    if (row.lastFetchedAt && started.getTime() - row.lastFetchedAt.getTime() < interval) continue;

    const report: SourceReport = { slug: row.slug, status: "ok", fetched: 0, inserted: 0 };
    try {
      const since = row.lastSuccessAt
        ? new Date(row.lastSuccessAt.getTime() - SINCE_MARGIN_MS)
        : null;
      const result = await fetcher.fetch(
        {
          slug: row.slug,
          type: row.type,
          url: row.url,
          language: row.language,
          etag: row.etag,
          lastModified: row.lastModified,
        },
        since,
      );
      report.fetched = result.items.length;
      if (result.notModified) report.status = "not_modified";
      if (result.items.length > 0) {
        const inserted = await db
          .insert(items)
          .values(
            result.items.map((item) => ({
              userId,
              sourceId: row.id,
              url: item.url,
              canonicalUrl: canonicalizeUrl(item.url),
              title: item.title,
              text: item.text,
              contentHash: contentHash(item.title, item.text),
              language: item.language,
              publishedAt: item.publishedAt,
              fetchedAt: started,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: items.id });
        report.inserted = inserted.length;
      }
      await db
        .update(sources)
        .set({
          lastFetchedAt: started,
          lastSuccessAt: started,
          lastError: null,
          consecutiveFailures: 0,
          etag: result.etag,
          lastModified: result.lastModified,
        })
        .where(eq(sources.id, row.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.status = "failed";
      report.error = message;
      logger.warn({ source: row.slug, err: error }, "Source failed");
      try {
        await db
          .update(sources)
          .set({
            lastFetchedAt: started,
            lastFailureAt: started,
            lastError: message.slice(0, 500),
            consecutiveFailures: sql`${sources.consecutiveFailures} + 1`,
          })
          .where(eq(sources.id, row.id));
      } catch (dbError) {
        logger.error({ source: row.slug, err: dbError }, "Cannot record source failure");
      }
    }
    reports.push(report);
    logger.info(report, "Source collected");
  }
  return reports;
}
