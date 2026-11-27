import { resolve } from "node:path";
import { pino } from "pino";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { EMBEDDING_DIMENSIONS, items, sources, stories } from "../src/db/schema.js";
import type { EmbeddingsClient } from "../src/pipeline/embeddings.js";
import { runDedup } from "../src/pipeline/dedup.js";

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const HOUR = 3_600_000;

function vector(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01);
  v[axis] = 1;
  return v;
}

describe.skipIf(!url)("runDedup", () => {
  it("clusters items, caches embeddings and survives an embeddings failure", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const [low, high] = await db
        .insert(sources)
        .values(
          [2, 5].map((trust) => ({
            userId: 1,
            slug: `s${trust}`,
            name: `S${trust}`,
            type: "rss",
            url: `https://s${trust}.example/feed`,
            language: "en",
            trust,
            pollInterval: "1h",
            active: true,
          })),
        )
        .returning();
      const now = new Date();
      const row = (n: number, sourceId: number, title: string, hoursAgo: number) => ({
        userId: 1,
        sourceId,
        url: `https://x.example/${n}`,
        canonicalUrl: `https://x.example/${n}`,
        title,
        contentHash: `h${n}`,
        publishedAt: new Date(now.getTime() - hoursAgo * HOUR),
      });
      await db
        .insert(items)
        .values([
          row(1, low!.id, "quake media", 10),
          row(2, high!.id, "quake official", 8),
          row(3, low!.id, "vaccine news", 6),
        ]);

      const logger = pino({ level: "silent" });
      const base = { db, userId: 1, logger, threshold: 0.88, windowMs: 48 * HOUR };

      // The embeddings API fails: the run does not throw and the items stay unclustered.
      const failing: EmbeddingsClient = {
        embed: async () => {
          throw new Error("API down");
        },
      };
      const failed = await runDedup({ ...base, embeddings: failing });
      expect(failed.embeddingsFailed).toBe(true);
      expect(await db.$count(stories)).toBe(0);

      // The API works: the items are embedded once and clustered.
      let embedded = 0;
      const fake: EmbeddingsClient = {
        embed: async (texts) => {
          embedded += texts.length;
          return texts.map((t) => vector(t.includes("quake") ? 0 : 1));
        },
      };
      const ok = await runDedup({ ...base, embeddings: fake });
      expect(ok).toMatchObject({ embedded: 3, clustered: 3, newStories: 2 });
      const [quake] = await db.select().from(stories).orderBy(stories.id).limit(1);
      expect(quake!.title).toBe("quake official");

      // A second run does not embed the same items again.
      await runDedup({ ...base, embeddings: fake });
      expect(embedded).toBe(3);
    } finally {
      await client.end();
    }
  });
});
