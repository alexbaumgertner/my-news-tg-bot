import { describe, expect, it } from "vitest";
import {
  assignToStory,
  cosineSimilarity,
  type ClusterItem,
  type NearestStory,
  type Representative,
  type StoryStore,
} from "../src/pipeline/cluster.js";
import { clusterOptionsFromEnv, embeddingInput, itemTime } from "../src/pipeline/dedup.js";
import { parseEnv } from "../src/config.js";

const HOUR = 3_600_000;

/** Fake embeddings: each topic is one axis. A text gets the axis of the first topic word in it. */
const TOPICS: Record<string, number> = {
  claude: 0,
  клод: 0, // the same event in Russian
  earthquake: 1,
  землетрясение: 1,
  vaccine: 2,
};
function fakeEmbed(text: string): number[] {
  const vector = [0.05, 0.05, 0.05];
  const lower = text.toLowerCase();
  for (const [word, axis] of Object.entries(TOPICS)) {
    if (lower.includes(word)) {
      vector[axis] = 1;
      break;
    }
  }
  return vector;
}

interface StoryRow {
  id: number;
  embedding: number[];
  lastItemAt: Date;
  representative: ClusterItem;
  members: number[];
}

function memoryStore(): StoryStore & { stories: StoryRow[] } {
  const stories: StoryRow[] = [];
  return {
    stories,
    async findNearest(embedding, at, windowMs): Promise<NearestStory | null> {
      let best: NearestStory | null = null;
      for (const s of stories) {
        if (Math.abs(s.lastItemAt.getTime() - at.getTime()) > windowMs) continue;
        const similarity = cosineSimilarity(embedding, s.embedding);
        if (!best || similarity > best.similarity) {
          best = { storyId: s.id, similarity, representative: s.representative as Representative };
        }
      }
      return best;
    },
    async createStory(item) {
      const id = stories.length + 1;
      stories.push({
        id,
        embedding: item.embedding,
        lastItemAt: item.at,
        representative: item,
        members: [item.id],
      });
      return id;
    },
    async attach(storyId, item) {
      const s = stories.find((x) => x.id === storyId)!;
      s.members.push(item.id);
      if (item.at > s.lastItemAt) s.lastItemAt = item.at;
    },
    async setRepresentative(storyId, item) {
      const s = stories.find((x) => x.id === storyId)!;
      s.representative = item;
      s.embedding = item.embedding;
    },
  };
}

let nextId = 1;
function item(title: string, hoursAgo: number, extra: Partial<ClusterItem> = {}): ClusterItem {
  return {
    id: nextId++,
    title,
    embedding: fakeEmbed(title),
    trust: 3,
    at: new Date(Date.UTC(2026, 10, 27) - hoursAgo * HOUR),
    textLength: 500,
    ...extra,
  };
}

const options = { threshold: 0.88, windowMs: 48 * HOUR };

async function run(items: ClusterItem[]) {
  const store = memoryStore();
  const ids: number[] = [];
  for (const i of items) ids.push((await assignToStory(store, i, options)).storyId);
  return { store, ids };
}

describe("cosineSimilarity", () => {
  it("returns 1 for equal direction, 0 for orthogonal and 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("assignToStory", () => {
  it("merges similar titles in two languages and keeps unrelated items apart", async () => {
    const { ids } = await run([
      item("Anthropic releases new Claude model", 5),
      item("Anthropic выпустила новую модель Клод", 4),
      item("Earthquake hits the coast", 3),
      item("Землетрясение на побережье", 2),
      item("New vaccine trial results", 1),
    ]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(new Set(ids).size).toBe(3);
  });

  it("follows one story over several days, but not past the window", async () => {
    const { ids } = await run([
      item("Claude launch day one", 100),
      item("Claude launch day two", 70), // 30 h after the first
      item("Claude launch day three", 40), // 30 h after the second
      item("Claude day four", 10), // 30 h after the third
      item("Claude a new story", -40), // 50 h after the fourth: outside the 48 h window
    ]);
    expect(ids.slice(0, 4)).toEqual([ids[0], ids[0], ids[0], ids[0]]);
    expect(ids[4]).not.toBe(ids[0]);
  });

  it("uses the threshold from the options", async () => {
    const a = item("Claude news", 2);
    const b = { ...item("Claude again", 1), embedding: [1, 1, 0] };
    const loose = memoryStore();
    await assignToStory(loose, a, { ...options, threshold: 0.5 });
    expect((await assignToStory(loose, b, { ...options, threshold: 0.5 })).created).toBe(false);
    const strict = memoryStore();
    await assignToStory(strict, a, options);
    expect((await assignToStory(strict, b, options)).created).toBe(true);
  });

  it("picks the item with the highest trust as the representative", async () => {
    const blog = item("Claude on a media site", 6, { trust: 2 });
    const primary = item("Claude official announcement", 3, { trust: 5 });
    const { store } = await run([blog, primary]);
    expect(store.stories).toHaveLength(1);
    expect(store.stories[0]!.representative.id).toBe(primary.id);
  });

  it("breaks a trust tie by the earlier item, then by the longer text", async () => {
    const late = item("Claude late", 1, { trust: 4 });
    const early = item("Claude early", 5, { trust: 4 });
    const first = await run([late, early]);
    expect(first.store.stories[0]!.representative.id).toBe(early.id);

    const short = item("Claude short", 2, { trust: 4, at: early.at, textLength: 10 });
    const long = item("Claude long", 2, { trust: 4, at: early.at, textLength: 900 });
    const second = await run([short, long]);
    expect(second.store.stories[0]!.representative.id).toBe(long.id);
  });
});

describe("helpers", () => {
  it("reads the threshold and the window from the environment", () => {
    const env = parseEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_OWNER_ID: "1",
      DATABASE_URL: "postgres://x/y",
      ANTHROPIC_API_KEY: "k",
      DEDUP_SIMILARITY_THRESHOLD: "0.9",
      DEDUP_WINDOW_HOURS: "24",
    });
    expect(clusterOptionsFromEnv(env)).toEqual({ threshold: 0.9, windowMs: 24 * HOUR });
  });

  it("defaults to 0.88 and 48 hours", () => {
    const env = parseEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_OWNER_ID: "1",
      DATABASE_URL: "postgres://x/y",
      ANTHROPIC_API_KEY: "k",
    });
    expect(clusterOptionsFromEnv(env)).toEqual({ threshold: 0.88, windowMs: 48 * HOUR });
  });

  it("builds the embedding input and caps a future date", () => {
    expect(embeddingInput("T", null)).toBe("T");
    expect(embeddingInput("T", "body")).toBe("T\nbody");
    const fetched = new Date("2026-11-27T00:00:00Z");
    expect(itemTime(new Date("2026-12-30T00:00:00Z"), fetched)).toEqual(fetched);
    expect(itemTime(null, fetched)).toEqual(fetched);
  });
});
