import { resolve } from "node:path";
import { pino } from "pino";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { items, llmUsage, scores, sources, stories } from "../src/db/schema.js";
import { FakeProvider } from "../src/llm/provider.js";
import { runScoring } from "../src/llm/score.js";
import { createDbScoringStore } from "../src/llm/score-store.js";
import { profileSchema } from "../src/profile.js";

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

const profile = profileSchema.parse({
  version: 1,
  about_me: "test",
  hard_exclusions: { description: "x", keywords: ["gossip"] },
  safety_exception: { description: "x", keywords: ["Antalya"] },
  topics: [
    {
      id: "ai",
      title: "AI",
      weight: 1,
      description: "agents",
      keywords: ["a1", "a2", "a3", "a4", "a5"],
    },
  ],
});

const answer = JSON.stringify({
  topics: ["ai"],
  relevance: 7,
  impact: "work",
  why_me: "Useful.",
  novelty: 0.5,
  confidence: 0.7,
  is_russia_domestic: false,
  study_type: null,
});

describe.skipIf(!url)("scoring on the database", () => {
  it("scores only stories that passed the pre-filter, once per representative", async () => {
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
      const statuses = ["passed", "dropped", null, "passed"] as const;
      const ids: number[] = [];
      for (const [n, status] of statuses.entries()) {
        const [item] = await db
          .insert(items)
          .values({
            userId: 1,
            sourceId: src!.id,
            url: `https://x.example/${n}`,
            canonicalUrl: `https://x.example/${n}`,
            title: `Title ${n}`,
            text: "t".repeat(3000),
            contentHash: `h${n}`,
          })
          .returning();
        const [story] = await db
          .insert(stories)
          .values({
            userId: 1,
            title: `Title ${n}`,
            representativeItemId: item!.id,
            prefilterStatus: status,
          })
          .returning();
        ids.push(story!.id);
      }

      const provider = new FakeProvider((r) => (r.user.includes("Title 3") ? "oops" : answer));
      const run = () =>
        runScoring({
          store: createDbScoringStore(db, 1),
          provider,
          logger: pino({ level: "silent" }),
          profile,
          model: "test-model",
          mode: "sync",
          dailyCap: 100,
          dailyLimitUsd: 1,
          monthlyLimitUsd: 10,
          maxChars: 1500,
          maxOutputTokens: 500,
          pricing: {
            inputPerMTok: 1,
            outputPerMTok: 5,
            cacheReadPerMTok: 0.1,
            cacheWritePerMTok: 1.25,
            batchFactor: 0.5,
          },
        });

      const first = await run();
      expect(first).toMatchObject({ scored: 1, invalid: 1 });
      // Only the two stories that passed were sent. The text was cut to 1500 characters.
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]!.user.match(/t/g)!.length).toBeLessThan(1600);
      const rows = await db.select().from(scores);
      expect(rows.map((r) => r.storyId)).toEqual([ids[0]]);
      expect(await db.$count(llmUsage)).toBe(2);

      // The same batch entry key records its usage only once.
      const store = createDbScoringStore(db, 1);
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
      expect(await store.recordUsage("m", usage, 0.001, "b1:s1-i1")).toBe(true);
      expect(await store.recordUsage("m", usage, 0.001, "b1:s1-i1")).toBe(false);
      expect(await db.$count(llmUsage)).toBe(3);
      await db.delete(llmUsage).where(eq(llmUsage.batchEntryKey, "b1:s1-i1"));

      // A second run sends nothing: one story has a score, the other has invalid output.
      await run();
      expect(provider.requests).toHaveLength(2);

      // A new representative item makes the story eligible again.
      const [newItem] = await db
        .insert(items)
        .values({
          userId: 1,
          sourceId: src!.id,
          url: "https://x.example/new",
          canonicalUrl: "https://x.example/new",
          title: "Title 0 updated",
          contentHash: "hnew",
        })
        .returning();
      await db
        .update(stories)
        .set({ representativeItemId: newItem!.id })
        .where(eq(stories.id, ids[0]!));
      await run();
      expect(provider.requests).toHaveLength(3);
      const updated = await db.select().from(scores);
      expect(updated).toHaveLength(1);
      expect(updated[0]!.representativeItemId).toBe(newItem!.id);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
