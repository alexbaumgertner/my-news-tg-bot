import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { loadYamlFile, sourcesFileSchema } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { seedSources, sourceToRow } from "../src/db/seed.js";
import { items, sources } from "../src/db/schema.js";

describe("sourceToRow", () => {
  it("maps every source in config/sources.yaml and sets user_id", () => {
    const file = loadYamlFile("config/sources.yaml", sourcesFileSchema);
    const rows = file.sources.map((s) => sourceToRow(s, 7));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId === 7)).toBe(true);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
  });
});

// Integration tests need a throwaway PostgreSQL database with pgvector.
// Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("database", () => {
  it("migrates and seeds idempotently and enforces unique items", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const first = await seedSources(db, "config", 1);
      await seedSources(db, "config", 1);
      expect(await db.$count(sources)).toBe(first);

      const [source] = await db.select().from(sources).limit(1);
      const row = {
        userId: 1,
        sourceId: source!.id,
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        title: "A",
        contentHash: "hash-a",
      };
      await db.insert(items).values(row);
      await expect(db.insert(items).values({ ...row, contentHash: "other" })).rejects.toThrow();
      await expect(
        db.insert(items).values({ ...row, canonicalUrl: "https://example.com/b" }),
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
