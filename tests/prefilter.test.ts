import { resolve } from "node:path";
import { pino } from "pino";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client.js";
import { EMBEDDING_DIMENSIONS, items, sources, stories } from "../src/db/schema.js";
import { parseEnv } from "../src/config.js";
import { loadProfile, loadProfileOrExample, profileSchema, type Profile } from "../src/profile.js";
import { createDbStoryStore } from "../src/pipeline/dedup.js";
import type { EmbeddingsClient } from "../src/pipeline/embeddings.js";
import {
  KeywordMatcher,
  Prefilter,
  TopicEmbeddingCache,
  prefilterOptionsFromEnv,
  runPrefilter,
  tokenize,
} from "../src/pipeline/prefilter.js";

const profile: Profile = profileSchema.parse({
  version: 1,
  about_me: "test",
  hard_exclusions: { description: "x", keywords: ["celebrity", "шок"] },
  safety_exception: { description: "x", keywords: ["Antalya", "Анталья"] },
  topics: [
    {
      id: "ai",
      title: "AI",
      weight: 1,
      description: "agents",
      keywords: ["Claude Code", "MCP", "ИИ-агент", "C++ (beta)", "a.b*c", "one", "two"],
      stop_words: ["webinar", "sponsored"],
    },
    {
      id: "sport",
      title: "Sport",
      weight: 0.3,
      description: "volleyball",
      keywords: ["волейбол", "VNL", "k3", "k4", "k5"],
      stop_words: ["betting"],
    },
  ],
});

const options = { minSimilarity: 0.4, weightDiscount: 0.05 };
const filter = new Prefilter(profile, options);
// Topic vectors: "ai" on axis 0, "sport" on axis 1.
const topicVectors = [
  [1, 0, 0],
  [0, 1, 0],
];
const story = (title: string, text: string | null = null, embedding: number[] | null = null) => ({
  title,
  text,
  embedding,
});

describe("KeywordMatcher", () => {
  it("matches case-insensitive whole words and phrases", () => {
    const m = new KeywordMatcher(["Claude Code", "MCP"]);
    expect(m.find("New CLAUDE code release")).toBe("Claude Code");
    expect(m.find("the mcp server")).toBe("MCP");
    expect(m.find("Claude and Code apart")).toBeNull();
    expect(m.find("mcpx tools")).toBeNull();
  });

  it("matches English plurals but not longer words", () => {
    const m = new KeywordMatcher(["agent", "Neon"]);
    expect(m.find("many agents")).toBe("agent");
    expect(m.find("neonatal care")).toBeNull();
  });

  it("matches Cyrillic word stems and folds ё", () => {
    const m = new KeywordMatcher(["память", "землетрясение", "ёлка"]);
    expect(m.find("О памяти и сне")).toBe("память");
    expect(m.find("Сильное землетрясения в регионе")).toBe("землетрясение");
    expect(m.find("новая елка")).toBe("ёлка");
    expect(m.find("памятник")).toBeNull();
  });

  it("does not stem short Cyrillic keywords", () => {
    const m = new KeywordMatcher(["шок"]);
    expect(m.find("Шок! Новости")).toBe("шок");
    expect(m.find("шокирующий факт")).toBeNull();
  });

  it("treats regex characters in keywords as plain text", () => {
    const m = new KeywordMatcher(["C++ (beta)", "a.b*c", "(", "[", "\\"]);
    expect(m.find("We use C++ (beta) here")).toBe("C++ (beta)");
    expect(m.find("axbbc")).toBeNull();
    expect(m.find("a.b*c")).toBe("a.b*c");
    expect(m.find("plain text")).toBeNull();
  });

  it("does not throw on text with regex characters", () => {
    const m = new KeywordMatcher(["abc"]);
    expect(m.find("(((( [[[ \\ ** ++ ?? $^")).toBeNull();
  });

  it("limits the number of words", () => {
    expect(tokenize("a b c d", 2)).toEqual(["a", "b"]);
  });
});

describe("Prefilter rules", () => {
  it("rule 1: a safety keyword passes", () => {
    const d = filter.decide(story("Antalya road closed"), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "safety" });
  });

  it("rule 1 beats a stop word and a hard exclusion", () => {
    const d = filter.decide(story("Celebrity webinar in Antalya"), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "safety" });
    const ru = filter.decide(story("Шок: пожар в Анталье, спонсировано sponsored"), topicVectors);
    expect(ru).toMatchObject({ status: "passed", reason: "safety" });
  });

  it("rule 2: a hard exclusion drops, even with a topic keyword", () => {
    const d = filter.decide(story("Celebrity uses Claude Code"), topicVectors);
    expect(d).toMatchObject({ status: "dropped", reason: "hard_exclusion" });
  });

  it("rule 2: a stop word drops, even with a topic keyword", () => {
    const d = filter.decide(story("Claude Code webinar"), topicVectors);
    expect(d).toMatchObject({ status: "dropped", reason: "stop_word", topicIds: ["ai"] });
  });

  it("rule 2: a stop word of one topic drops the story", () => {
    const d = filter.decide(story("Волейбол: betting tips"), topicVectors);
    expect(d).toMatchObject({ status: "dropped", reason: "stop_word", topicIds: ["sport"] });
  });

  it("rule 3: topic keywords pass and record all topic ids", () => {
    const d = filter.decide(story("Claude Code at the VNL"), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "keyword", topicIds: ["ai", "sport"] });
  });

  it("reads the text as well as the title", () => {
    const d = filter.decide(story("Weekly news", "A long text about MCP servers."), null);
    expect(d).toMatchObject({ status: "passed", reason: "keyword", topicIds: ["ai"] });
  });

  it("matches Russian keywords", () => {
    const d = filter.decide(story("Чемпионат по волейболу стартовал"), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "keyword", topicIds: ["sport"] });
    const agent = filter.decide(story("Новый ИИ-агент от Anthropic"), topicVectors);
    expect(agent).toMatchObject({ reason: "keyword", topicIds: ["ai"] });
  });

  it("rule 4: similarity at the bar passes and records the best topic", () => {
    // Weight 0.3 -> bar 0.4 - 0.015 = 0.385. cos([0.4, 0.92, 0], [0, 1, 0]) is about 0.9.
    const d = filter.decide(story("Unrelated words", null, [0.4, 0.92, 0]), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "similarity", topicIds: ["sport"] });
    expect(d.similarity).toBeGreaterThan(0.85);
  });

  it("rule 4: the topic weight lowers the bar", () => {
    expect(filter.thresholdFor(1)).toBeCloseTo(0.35);
    expect(filter.thresholdFor(0.3)).toBeCloseTo(0.385);
    // Similarity 0.37 to "ai" (weight 1, bar 0.35) passes. Same value to "sport" (bar 0.385) drops.
    const s = 0.37;
    const rest = Math.sqrt(1 - s * s);
    const ai = filter.decide(story("x", null, [s, 0, rest]), topicVectors);
    expect(ai).toMatchObject({ status: "passed", reason: "similarity", topicIds: ["ai"] });
    const sport = filter.decide(story("x", null, [0, s, rest]), topicVectors);
    expect(sport).toMatchObject({ status: "dropped", reason: "no_match" });
  });

  it("rule 5: low similarity drops", () => {
    const d = filter.decide(story("Unrelated words", null, [0, 0, 1]), topicVectors);
    expect(d).toMatchObject({ status: "dropped", reason: "no_match" });
  });

  it("fail open: without topic vectors, stories that no keyword decides pass", () => {
    const d = filter.decide(story("Unrelated words", null, [0, 0, 1]), null);
    expect(d).toMatchObject({ status: "passed", reason: "fail_open" });
  });

  it("fail open: a story without an embedding passes", () => {
    const d = filter.decide(story("Unrelated words"), topicVectors);
    expect(d).toMatchObject({ status: "passed", reason: "fail_open" });
  });

  it("fail open still applies rules 1-3", () => {
    expect(filter.decide(story("Celebrity news"), null)).toMatchObject({ status: "dropped" });
    expect(filter.decide(story("Antalya fire"), null)).toMatchObject({ reason: "safety" });
    expect(filter.decide(story("Claude Code"), null)).toMatchObject({ reason: "keyword" });
  });
});

describe("TopicEmbeddingCache", () => {
  const fake = () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 0]));
    return { embed } satisfies EmbeddingsClient;
  };

  it("embeds each description once", async () => {
    const client = fake();
    const cache = new TopicEmbeddingCache();
    expect(await cache.getMany(["aa", "bbb", "aa"], client)).toEqual([
      [2, 0],
      [3, 0],
      [2, 0],
    ]);
    await cache.getMany(["aa", "bbb"], client);
    expect(client.embed).toHaveBeenCalledTimes(1);
    expect(client.embed).toHaveBeenCalledWith(["aa", "bbb"]);
  });

  it("embeds only new or changed descriptions", async () => {
    const client = fake();
    const cache = new TopicEmbeddingCache();
    await cache.getMany(["aa"], client);
    await cache.getMany(["aa", "new"], client);
    expect(client.embed).toHaveBeenLastCalledWith(["new"]);
  });

  it("expires entries", async () => {
    const client = fake();
    let now = 0;
    const cache = new TopicEmbeddingCache({ ttlMs: 1000, now: () => now });
    await cache.getMany(["aa"], client);
    now = 1001;
    await cache.getMany(["aa"], client);
    expect(client.embed).toHaveBeenCalledTimes(2);
  });
});

describe("config and profile loading", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_OWNER_ID: "1",
    DATABASE_URL: "postgres://x/y",
    ANTHROPIC_API_KEY: "k",
  };

  it("reads the thresholds from the environment", () => {
    expect(prefilterOptionsFromEnv(parseEnv(env))).toEqual({
      minSimilarity: 0.4,
      weightDiscount: 0.05,
    });
    const custom = parseEnv({ ...env, PREFILTER_MIN_SIMILARITY: "0.55" });
    expect(prefilterOptionsFromEnv(custom).minSimilarity).toBe(0.55);
  });

  it("uses the example profile and warns when profile.yaml is missing", () => {
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const loaded = loadProfileOrExample(resolve("config"), logger);
    expect(loaded.topics.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("loads the example profile and filters with it", () => {
    const example = loadProfile(resolve("config/profile.example.yaml"));
    const f = new Prefilter(example, options);
    expect(f.decide(story("Turkey earthquake today"), null).reason).toBe("safety");
    expect(f.decide(story("Землетрясение: Турция землетрясение"), null).reason).toBe("safety");
    expect(f.decide(story("Gossip about a star"), null).reason).toBe("hard_exclusion");
  });
});

// Needs a throwaway PostgreSQL database with pgvector. Run: TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

function vec(...head: number[]): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  head.forEach((x, i) => (v[i] = x));
  return v;
}

describe.skipIf(!url)("runPrefilter", () => {
  it("stores decisions, counts per source and fails open", async () => {
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
      const titles = ["Antalya fire", "Celebrity news", "Claude Code 3", "Plain words", "Other"];
      const embeddings = [vec(0, 0, 1), vec(0, 0, 1), vec(0, 0, 1), vec(1), vec(0, 0, 1)];
      for (const [n, title] of titles.entries()) {
        const [item] = await db
          .insert(items)
          .values({
            userId: 1,
            sourceId: src!.id,
            url: `https://x.example/${n}`,
            canonicalUrl: `https://x.example/${n}`,
            title,
            contentHash: `h${n}`,
          })
          .returning();
        await db
          .insert(stories)
          .values({ userId: 1, title, embedding: embeddings[n]!, representativeItemId: item!.id });
      }
      const base = {
        db,
        userId: 1,
        logger: pino({ level: "silent" }),
        profile,
        ...options,
        batchSize: 2,
      };
      const failing: EmbeddingsClient = {
        embed: async () => {
          throw new Error("down");
        },
      };
      const report = await runPrefilter({ ...base, embeddings: failing });
      expect(report.embeddingsFailed).toBe(true);
      expect(report.dropped).toBe(1);
      expect(report.passed).toBe(4);
      expect(report.bySource.feed).toMatchObject({ safety: 1, hard_exclusion: 1, keyword: 1 });
      const rows = await db.select().from(stories);
      expect(rows.every((r) => r.prefilterStatus !== null && r.prefilterAt !== null)).toBe(true);

      // Decided stories are not decided again.
      const again = await runPrefilter({ ...base, embeddings: failing });
      expect(again.passed + again.dropped).toBe(0);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
  it("decides a story again only when its representative changes", async () => {
    const { db, client } = createDb(url!, { max: 1 });
    try {
      await client.unsafe(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
      );
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      const addSource = async (slug: string, trust: number) => {
        const [row] = await db
          .insert(sources)
          .values({
            userId: 1,
            slug,
            name: slug,
            type: "rss",
            url: `https://${slug}.example/rss`,
            language: "en",
            trust,
            pollInterval: "1h",
            active: true,
          })
          .returning();
        return row!;
      };
      const addItem = async (sourceId: number, n: number, title: string) => {
        const [row] = await db
          .insert(items)
          .values({
            userId: 1,
            sourceId,
            url: `https://x.example/${n}`,
            canonicalUrl: `https://x.example/${n}`,
            title,
            contentHash: `h${n}`,
          })
          .returning();
        return row!;
      };
      const secondary = await addSource("secondary", 2);
      const primary = await addSource("primary", 5);
      const weak = await addItem(secondary.id, 1, "Plain words");
      const strong = await addItem(primary.id, 2, "Claude Code 3 released");
      const [story] = await db
        .insert(stories)
        .values({ userId: 1, title: weak.title, embedding: vec(1), representativeItemId: weak.id })
        .returning();
      const embed = vi.fn(async (texts: string[]) => texts.map(() => vec(0, 0, 1)));
      const base = {
        db,
        userId: 1,
        logger: pino({ level: "silent" }),
        profile,
        ...options,
        embeddings: { embed } as EmbeddingsClient,
      };

      const first = await runPrefilter(base);
      expect(first.dropped).toBe(1);
      const [dropped] = await db.select().from(stories);
      expect(dropped!.prefilterStatus).toBe("dropped");

      // Unchanged representative: the story is not evaluated again.
      const second = await runPrefilter(base);
      expect(second.passed + second.dropped).toBe(0);

      // A new representative clears the decision. The story passes on the keyword.
      await createDbStoryStore(db, 1).setRepresentative(story!.id, {
        id: strong.id,
        title: strong.title,
        embedding: vec(1),
        trust: 5,
        at: new Date(),
        textLength: 0,
      });
      const [cleared] = await db.select().from(stories);
      expect(cleared!.prefilterStatus).toBeNull();
      const third = await runPrefilter(base);
      expect(third.passed).toBe(1);
      const [passed] = await db.select().from(stories);
      expect(passed!.prefilterStatus).toBe("passed");
      expect(passed!.prefilterReason).toBe("keyword");
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
