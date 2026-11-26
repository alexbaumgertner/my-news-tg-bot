import { resolve } from "node:path";
import { pino } from "pino";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { items, sources } from "../src/db/schema.js";
import { runCollector } from "../src/fetchers/collector.js";
import type { Fetcher } from "../src/fetchers/types.js";

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("collector", () => {
  it("isolates failures, skips duplicates and respects poll interval", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const base = {
        userId: 1,
        type: "rss",
        language: "en",
        trust: 3,
        pollInterval: "1h",
        active: true,
      };
      await db.insert(sources).values([
        { ...base, slug: "bad", name: "Bad", url: "https://bad.example/feed" },
        { ...base, slug: "good", name: "Good", url: "https://good.example/feed" },
      ]);
      const fetcher: Fetcher = {
        async fetch(source) {
          if (source.slug === "bad") throw new Error("boom");
          return {
            items: [
              {
                url: "https://good.example/a",
                title: "A",
                text: null,
                publishedAt: new Date("2026-11-25T00:00:00Z"),
                language: "en",
              },
            ],
            notModified: false,
            etag: '"e1"',
            lastModified: null,
          };
        },
      };
      const logger = pino({ level: "silent" });
      let now = new Date("2026-11-26T10:00:00Z");
      const run = () =>
        runCollector({ db, userId: 1, fetchers: { rss: fetcher }, logger, now: () => now });

      const first = await run();
      expect(first.map((r) => [r.slug, r.status, r.inserted])).toEqual([
        ["bad", "failed", 0],
        ["good", "ok", 1],
      ]);

      // Too early: nothing is due.
      expect(await run()).toEqual([]);

      // Due again: the same item is not inserted twice.
      now = new Date("2026-11-26T11:30:00Z");
      const second = await run();
      expect(second.find((r) => r.slug === "good")?.inserted).toBe(0);
      expect(await db.$count(items)).toBe(1);

      const rows = await db.select().from(sources);
      const bad = rows.find((r) => r.slug === "bad")!;
      const good = rows.find((r) => r.slug === "good")!;
      expect(bad.consecutiveFailures).toBe(2);
      expect(bad.lastError).toBe("boom");
      expect(good.etag).toBe('"e1"');
      expect(good.lastSuccessAt).not.toBeNull();
    } finally {
      await client.end();
    }
  });
});
