import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { items, scores, sources, stories } from "../src/db/schema.js";
import { loadRankCandidates } from "../src/pipeline/rank.js";

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rank candidates on the database", () => {
  it("ranks only passed stories with a score for the current representative", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const [src] = await db
        .insert(sources)
        .values({
          userId: 1,
          slug: "feed",
          name: "Feed",
          type: "rss",
          url: "https://feed.example/rss",
          language: "en",
          trust: 3,
          pollInterval: "1h",
          active: true,
        })
        .returning();
      const now = new Date();
      let n = 0;
      const addItem = async () => {
        n += 1;
        const [item] = await db
          .insert(items)
          .values({
            userId: 1,
            sourceId: src!.id,
            url: `https://x.example/${n}`,
            canonicalUrl: `https://x.example/${n}`,
            title: `Title ${n}`,
            text: "t",
            contentHash: `h${n}`,
          })
          .returning();
        return item!.id;
      };
      const addStory = async (status: string | null) => {
        const itemId = await addItem();
        const [story] = await db
          .insert(stories)
          .values({
            userId: 1,
            title: `Story ${n}`,
            representativeItemId: itemId,
            prefilterStatus: status,
            lastItemAt: now,
          })
          .returning();
        await db.insert(scores).values({
          userId: 1,
          storyId: story!.id,
          topics: ["ai"],
          relevance: 8,
          impact: "work",
          whyMe: "Useful.",
          model: "m",
          promptVersion: "v1",
          representativeItemId: itemId,
        });
        return story!.id;
      };

      const fresh = await addStory("passed");
      const changed = await addStory("passed");
      const dropped = await addStory("dropped");
      const waiting = await addStory(null);
      // The representative of `changed` is replaced after scoring.
      await db
        .update(stories)
        .set({ representativeItemId: await addItem() })
        .where(eq(stories.id, changed));

      const since = new Date(now.getTime() - 3_600_000);
      const result = await loadRankCandidates(db, 1, since);
      expect(result.map((c) => c.storyId)).toEqual([fresh]);
      expect([changed, dropped, waiting]).not.toContain(result[0]?.storyId);
    } finally {
      await client.end();
    }
  });
});
