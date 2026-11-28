import { join } from "node:path";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { loadYamlFile, sourcesFileSchema, type Source } from "../config.js";
import type { Db } from "./client.js";
import { sources } from "./schema.js";

export function sourceToRow(source: Source, userId: number): typeof sources.$inferInsert {
  return {
    userId,
    slug: source.id,
    name: source.name,
    type: source.type,
    url: source.url,
    language: source.language,
    topics: source.topics,
    trust: source.trust,
    pollInterval: source.poll_interval,
    active: source.active,
    verified: source.verified ?? null,
    notes: source.notes ?? null,
    initialLookbackDays: source.initial_lookback_days ?? null,
  };
}

/**
 * Insert or update `sources` rows from config/sources.yaml. Safe to run many times.
 * A row whose id is not in the file gets `active = false`. Rows are never deleted: items refer to them.
 */
export async function seedSources(db: Db, configDir: string, userId: number): Promise<number> {
  const file = loadYamlFile(join(configDir, "sources.yaml"), sourcesFileSchema);
  const rows = file.sources.map((s) => sourceToRow(s, userId));
  const slugs = rows.map((r) => r.slug);
  await db
    .update(sources)
    .set({ active: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.active, true),
        slugs.length > 0 ? notInArray(sources.slug, slugs) : undefined,
      ),
    );
  if (rows.length === 0) return 0;
  await db
    .insert(sources)
    .values(rows)
    .onConflictDoUpdate({
      target: [sources.userId, sources.slug],
      set: {
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        url: sql`excluded.url`,
        language: sql`excluded.language`,
        topics: sql`excluded.topics`,
        trust: sql`excluded.trust`,
        pollInterval: sql`excluded.poll_interval`,
        active: sql`excluded.active`,
        verified: sql`excluded.verified`,
        notes: sql`excluded.notes`,
        initialLookbackDays: sql`excluded.initial_lookback_days`,
        updatedAt: sql`now()`,
      },
    });
  return rows.length;
}
