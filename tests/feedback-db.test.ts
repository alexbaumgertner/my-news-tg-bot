import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import {
  digestItems,
  digests,
  feedback,
  items,
  sources,
  stories,
  weightAdjustments,
} from "../src/db/schema.js";
import { createDbFeedbackStore, loadAdjustments } from "../src/feedback/store.js";
import { DEFAULT_FEEDBACK_CONFIG } from "../src/feedback/rules.js";

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("feedback on the database", () => {
  it("stores one vote per item and recomputes the adjustments", async () => {
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
      const [item] = await db
        .insert(items)
        .values({
          userId: 1,
          sourceId: src!.id,
          url: "https://feed.example/a",
          canonicalUrl: "https://feed.example/a",
          title: "A",
          contentHash: "h1",
          textFormat: "text",
        } as never)
        .returning();
      const [story] = await db
        .insert(stories)
        .values({ userId: 1, title: "A", representativeItemId: item!.id, prefilterTopics: ["ai"] })
        .returning();
      const [digest] = await db
        .insert(digests)
        .values({ userId: 1, kind: "morning", language: "en", digestDate: "2026-11-27" } as never)
        .returning();
      await db.insert(digestItems).values({
        userId: 1,
        digestId: digest!.id,
        storyId: story!.id,
        position: 1,
        headline: "A",
        summary: "S",
        url: "https://feed.example/a",
      });

      const store = createDbFeedbackStore(db, DEFAULT_FEEDBACK_CONFIG);
      const action = { digestId: digest!.id, position: 1, vote: "up" as const };

      expect(await store.press(1, action)).toEqual({ status: "stored", vote: "up" });
      let rows = await db.select().from(feedback);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "up",
        storyId: story!.id,
        sourceId: src!.id,
        topics: ["ai"],
      });
      let adj = await loadAdjustments(db, 1, DEFAULT_FEEDBACK_CONFIG);
      expect(adj.topics.get("ai")).toBe(1.05);
      expect(adj.sources.get(src!.id)).toBe(1.05);

      // Change the vote: still one row, and the result is recomputed, not added.
      expect(await store.press(1, { ...action, vote: "down" })).toEqual({
        status: "stored",
        vote: "down",
      });
      rows = await db.select().from(feedback);
      expect(rows).toHaveLength(1);
      adj = await loadAdjustments(db, 1, DEFAULT_FEEDBACK_CONFIG);
      expect(adj.topics.get("ai")).toBe(0.95);

      // The same press again clears the vote and the adjustment.
      expect(await store.press(1, { ...action, vote: "down" })).toEqual({
        status: "stored",
        vote: null,
      });
      expect(await db.select().from(feedback)).toHaveLength(0);
      expect(await db.select().from(weightAdjustments)).toHaveLength(0);

      // Unknown item and another user's item.
      expect(await store.press(1, { ...action, position: 9 })).toEqual({ status: "not_found" });
      expect(await store.press(2, action)).toEqual({ status: "not_found" });

      // The database refuses a second vote row for one item.
      const [di] = await db.select().from(digestItems).where(eq(digestItems.userId, 1));
      await db.insert(feedback).values({ userId: 1, digestItemId: di!.id, kind: "up" });
      await expect(
        db.insert(feedback).values({ userId: 1, digestItemId: di!.id, kind: "down" }),
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
