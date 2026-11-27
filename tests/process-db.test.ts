import { resolve } from "node:path";
import { pino } from "pino";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { items, scores, sources, stories } from "../src/db/schema.js";
import { FakeProvider } from "../src/llm/provider.js";
import { profileSchema } from "../src/profile.js";
import { runProcess } from "../src/process-run.js";

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
      keywords: ["agents", "mcp", "claude", "llm", "tooling"],
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

const base = {
  cluster: { threshold: 0.88, windowMs: 48 * 3_600_000 },
  prefilter: { minSimilarity: 0.4, weightDiscount: 0.05 },
};
const scoring = {
  model: "m",
  mode: "sync" as const,
  dailyCap: 100,
  dailyLimitUsd: 10,
  monthlyLimitUsd: 100,
  maxChars: 1500,
  maxOutputTokens: 500,
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    batchFactor: 0.5,
  },
};

describe.skipIf(!url)("process run on the database", () => {
  it("scores new stories with a fake provider and skips scoring without a key", async () => {
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
          url: "https://x.example/1",
          canonicalUrl: "https://x.example/1",
          title: "Claude agents and MCP tooling",
          text: "Body",
          contentHash: "h1",
          publishedAt: new Date(),
        })
        .returning();
      const [story] = await db
        .insert(stories)
        .values({ userId: 1, title: item!.title, representativeItemId: item!.id })
        .returning();

      const common = { db, userId: 1, logger: pino({ level: "silent" }), profile, ...base };
      // No keys: the story passes the pre-filter by keyword. Scoring is skipped, no crash.
      const skipped = await runProcess({
        ...common,
        embeddings: null,
        scoring: { ...scoring, provider: null },
      });
      expect(skipped.scoring.status).toBe("no_api_key");
      expect(skipped.prefilter.passed).toBe(1);
      expect(await db.select().from(scores)).toHaveLength(0);

      const provider = new FakeProvider(() => answer);
      const scored = await runProcess({
        ...common,
        embeddings: null,
        scoring: { ...scoring, provider },
      });
      expect(scored.scoring.scored).toBe(1);
      expect((await db.select().from(scores))[0]!.storyId).toBe(story!.id);

      // A second run has nothing new to score.
      const again = await runProcess({
        ...common,
        embeddings: null,
        scoring: { ...scoring, provider },
      });
      expect(again.scoring.scored).toBe(0);
    } finally {
      await client.end();
    }
  });
});
