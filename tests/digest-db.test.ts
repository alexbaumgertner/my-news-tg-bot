import { resolve } from "node:path";
import { pino } from "pino";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { digestItems, digests, items, scores, sources, stories } from "../src/db/schema.js";
import { runDigest, type MessageSender } from "../src/digest/run.js";
import { createDbDigestStore } from "../src/digest/store.js";
import { FakeProvider } from "../src/llm/provider.js";
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

const composed = JSON.stringify({
  headline: "Sub-agents arrive",
  summary: "The release adds sub-agents.",
  why_me: "It changes your workflow.",
});

describe.skipIf(!url)("digest run on the database", () => {
  it("sends once, retries after a failed send and counts filtered items", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const now = new Date();
      const [src] = await db
        .insert(sources)
        .values({
          userId: 1,
          slug: "feed",
          name: "Feed",
          type: "rss",
          url: "https://feed.example/rss",
          language: "en",
          trust: 4,
          pollInterval: "1h",
          active: true,
        })
        .returning();
      let n = 0;
      const addItem = async (withStory: boolean) => {
        n += 1;
        const [item] = await db
          .insert(items)
          .values({
            userId: 1,
            sourceId: src!.id,
            url: `https://x.example/${n}`,
            canonicalUrl: `https://x.example/${n}`,
            title: `Title ${n}`,
            text: "Body text",
            contentHash: `h${n}`,
            publishedAt: now,
          })
          .returning();
        if (!withStory) return item!.id;
        const [story] = await db
          .insert(stories)
          .values({
            userId: 1,
            title: `Story ${n}`,
            representativeItemId: item!.id,
            prefilterStatus: "passed",
            lastItemAt: now,
          })
          .returning();
        await db.update(items).set({ storyId: story!.id }).where(eq(items.id, item!.id));
        await db.insert(scores).values({
          userId: 1,
          storyId: story!.id,
          topics: ["ai"],
          relevance: 8,
          impact: "work",
          whyMe: "Useful.",
          model: "m",
          promptVersion: "v1",
          representativeItemId: item!.id,
        });
        return story!.id;
      };
      const storyId = await addItem(true);
      await addItem(false);
      await addItem(false);

      const sent: string[] = [];
      let fail = true;
      const sender: MessageSender = {
        async send(_chat, html) {
          if (fail) throw new Error("down");
          sent.push(html);
          return 7;
        },
      };
      const run = (dryRun = false) =>
        runDigest({
          store: createDbDigestStore({ db, userId: 1, profile, windowHours: 24 }),
          sender,
          usageStore: createDbScoringStore(db, 1),
          provider: new FakeProvider(() => composed),
          logger: pino({ level: "silent" }),
          profile,
          kind: "morning",
          language: "en",
          timeZone: "UTC",
          chatId: 1,
          dryRun,
          print: () => {},
          windowHours: 24,
          model: "m",
          maxChars: 1500,
          maxOutputTokens: 800,
          pricing: {
            inputPerMTok: 1,
            outputPerMTok: 5,
            cacheReadPerMTok: 0.1,
            cacheWritePerMTok: 1.25,
            batchFactor: 0.5,
          },
          dailyLimitUsd: 10,
          monthlyLimitUsd: 100,
        });

      expect((await run(true)).status).toBe("dry_run");
      expect(await db.select().from(digests)).toHaveLength(0);

      await expect(run()).rejects.toThrow("Telegram send failed");
      let rows = await db.select().from(digests);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sentAt).toBeNull();

      fail = false;
      expect((await run()).status).toBe("sent");
      rows = await db.select().from(digests);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sentAt).not.toBeNull();
      expect(rows[0]!.telegramMessageIds).toEqual([7]);
      const dItems = await db.select().from(digestItems);
      expect(dItems.map((i) => i.storyId)).toEqual([storyId]);
      // Two items without a story are filtered out. They come from one source.
      expect(sent[0]).toContain("Filtered out: 2 items from 1 sources.");

      expect((await run()).status).toBe("already_sent");
      expect(sent).toHaveLength(1);

      // Claims. A second claim of an active slot fails. An expired lease is taken over.
      const store = createDbDigestStore({ db, userId: 1, profile, windowHours: 24 });
      const slot = { kind: "evening" as const, date: "2026-01-01", language: "en" as const };
      const t0 = new Date("2026-01-01T10:00:00Z");
      const claim = (await store.claimDigest({ ...slot, items: [] }, t0))!;
      expect(
        await store.claimDigest({ ...slot, items: [] }, new Date(t0.getTime() + 1000)),
      ).toBeNull();
      const late = new Date(t0.getTime() + 11 * 60_000);
      const taken = (await store.claimDigest({ ...slot, items: [] }, late))!;
      expect(taken.digestId).toBe(claim.digestId);
      await expect(store.markSent(claim, [1], late)).rejects.toThrow("no longer owns");
      await store.markSent(taken, [1], late);
      expect(
        await store.claimDigest({ ...slot, items: [] }, new Date(late.getTime() + 3_600_000)),
      ).toBeNull();
    } finally {
      await client.end();
    }
  });
});
