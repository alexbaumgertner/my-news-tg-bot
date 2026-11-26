import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HnFetcher } from "../src/fetchers/hn.js";
import type { FetchSource } from "../src/fetchers/types.js";

const API = "https://hacker-news.firebaseio.com/v0/";
const source: FetchSource = {
  slug: "hacker-news-front",
  type: "hn",
  url: `${API}topstories.json`,
  language: "en",
  etag: null,
  lastModified: null,
};

function fixtureFetch(overrides: Record<string, Response> = {}) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const override = overrides[url];
    if (override) return override;
    const name = url.slice(API.length).replace("item/", "");
    return new Response(readFileSync(`tests/fixtures/hn/${name}`, "utf8"));
  });
  return mock as unknown as typeof fetch & typeof mock;
}

function makeFetcher(fetchImpl: typeof fetch, minScore = 100) {
  return new HnFetcher({
    http: { userAgent: "test", fetchImpl, maxAttempts: 1 },
    minScore,
  });
}

describe("HnFetcher", () => {
  it("collects only stories at or above the score threshold", async () => {
    const result = await makeFetcher(fixtureFetch()).fetch(source, null);
    const titles = result.items.map((i) => i.title).sort();
    expect(titles).toEqual(["A new open model", "Ask HN: exactly at the threshold", "Old story"]);
  });

  it("changes the result when the threshold changes", async () => {
    const result = await makeFetcher(fixtureFetch(), 300).fetch(source, null);
    expect(result.items.map((i) => i.title)).toEqual(["A new open model"]);
  });

  it("stores the article URL as the item URL and the discussion as metadata", async () => {
    const result = await makeFetcher(fixtureFetch()).fetch(source, null);
    const item = result.items.find((i) => i.title === "A new open model")!;
    expect(item.url).toBe("https://example.com/open-model");
    expect(item.publishedAt).toEqual(new Date(1795000000 * 1000));
    expect(item.metadata).toEqual({
      hn: {
        id: 101,
        discussionUrl: "https://news.ycombinator.com/item?id=101",
        score: 350,
        comments: 120,
        author: "alice",
      },
    });
  });

  it("uses the discussion URL for stories without a link", async () => {
    const result = await makeFetcher(fixtureFetch()).fetch(source, null);
    const item = result.items.find((i) => i.title.startsWith("Ask HN"))!;
    expect(item.url).toBe("https://news.ycombinator.com/item?id=103");
  });

  it("skips non-stories, dead stories and stories older than `since`", async () => {
    const result = await makeFetcher(fixtureFetch()).fetch(source, new Date(1795000000 * 1000));
    const titles = result.items.map((i) => i.title).sort();
    expect(titles).toEqual(["A new open model", "Ask HN: exactly at the threshold"]);
  });

  it("skips a story that fails to load and keeps the others", async () => {
    const fetchImpl = fixtureFetch({ [`${API}item/101.json`]: new Response("x", { status: 404 }) });
    const result = await makeFetcher(fetchImpl).fetch(source, null);
    expect(result.items.map((i) => i.title)).not.toContain("A new open model");
    expect(result.items.length).toBe(2);
  });

  it("throws when every story request fails", async () => {
    const ids = JSON.parse(readFileSync("tests/fixtures/hn/topstories.json", "utf8")) as number[];
    const overrides: Record<string, Response> = {};
    for (const id of ids) overrides[`${API}item/${id}.json`] = new Response("x", { status: 500 });
    const fetchImpl = fixtureFetch(overrides);
    await expect(makeFetcher(fetchImpl).fetch(source, null)).rejects.toThrow(/story requests failed/);
  });

  it("throws when the list cannot be loaded", async () => {
    const fetchImpl = fixtureFetch({ [source.url]: new Response("x", { status: 500 }) });
    await expect(makeFetcher(fetchImpl).fetch(source, null)).rejects.toThrow();
  });

  it("limits how many stories it checks", async () => {
    const fetchImpl = fixtureFetch();
    const fetcher = new HnFetcher({
      http: { userAgent: "test", fetchImpl, maxAttempts: 1 },
      minScore: 0,
      limit: 2,
    });
    await fetcher.fetch(source, null);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
