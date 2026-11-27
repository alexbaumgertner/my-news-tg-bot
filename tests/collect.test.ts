import { resolve } from "node:path";
import { pino } from "pino";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { collect, formatSummary } from "../src/collect-run.js";
import { createDb } from "../src/db/client.js";
import { items, sources } from "../src/db/schema.js";
import type { SourceReport } from "../src/fetchers/collector.js";
import type { Fetcher } from "../src/fetchers/types.js";

const report = (status: SourceReport["status"], fetched = 0, inserted = 0): SourceReport => ({
  slug: "s",
  status,
  fetched,
  inserted,
});

describe("formatSummary", () => {
  it("counts sources and items", () => {
    const line = formatSummary([report("ok", 5, 3), report("not_modified"), report("failed")]);
    expect(line).toBe(
      "Collection done: sources ok 1, not modified 1, failed 1; items fetched 5, inserted 3",
    );
  });

  it("handles a run with nothing due", () => {
    expect(formatSummary([])).toContain("sources ok 0, not modified 0, failed 0");
  });
});

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("collect", () => {
  it("seeds, collects, is idempotent and sets the exit code", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const logger = pino({ level: "silent" });
      const good: Fetcher = {
        async fetch() {
          return {
            items: [
              {
                url: "https://good.example/a",
                title: "A",
                text: "plain text",
                textFormat: "text",
                publishedAt: new Date("2026-11-25T00:00:00Z"),
                language: "en",
              },
            ],
            notModified: false,
            etag: null,
            lastModified: null,
          };
        },
      };
      const bad: Fetcher = {
        async fetch() {
          throw new Error("boom");
        },
      };
      const base = { configDir: "config", userId: 1, logger };

      // First run seeds the empty table. Make only one source active to keep the test small.
      const first = await collect({ ...base, db, fetchers: {} });
      expect(first.exitCode).toBe(0);
      expect(await db.$count(sources)).toBeGreaterThan(0);
      await client.unsafe("UPDATE sources SET active = false");
      await client.unsafe(
        "UPDATE sources SET active = true, last_fetched_at = NULL WHERE slug = (SELECT slug FROM sources WHERE type = 'rss' LIMIT 1)",
      );

      const failed = await collect({ ...base, db, fetchers: { rss: bad } });
      expect(failed.exitCode).toBe(1);
      expect(failed.reports.map((r) => r.status)).toEqual(["failed"]);

      await client.unsafe("UPDATE sources SET last_fetched_at = NULL");
      const ok = await collect({ ...base, db, fetchers: { rss: good } });
      expect(ok.exitCode).toBe(0);
      expect(ok.summary).toContain("items fetched 1, inserted 1");

      await client.unsafe("UPDATE sources SET last_fetched_at = NULL");
      const again = await collect({ ...base, db, fetchers: { rss: good } });
      expect(again.summary).toContain("inserted 0");
      expect(await db.$count(items)).toBe(1);

      // Nothing due: the source was just fetched.
      const idle = await collect({ ...base, db, fetchers: { rss: good } });
      expect(idle.exitCode).toBe(0);
      expect(idle.reports).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
