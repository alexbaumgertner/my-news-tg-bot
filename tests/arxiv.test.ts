import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ArxivFetcher, arxivApiUrl, arxivCategory } from "../src/fetchers/arxiv.js";
import type { FetchSource } from "../src/fetchers/types.js";

const xml = readFileSync("tests/fixtures/arxiv.xml", "utf8");

const source: FetchSource = {
  slug: "arxiv-cs-hc",
  type: "arxiv",
  url: "https://rss.arxiv.org/rss/cs.HC",
  language: "en",
  etag: null,
  lastModified: null,
};

function makeFetcher(bodies: string[], sleep = vi.fn(async () => {})) {
  const fetchImpl = vi.fn(async () => new Response(bodies.shift() ?? "", { status: 200 }));
  let clock = 0;
  const fetcher = new ArxivFetcher({
    http: {
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
    },
    now: () => clock,
  });
  return { fetcher, fetchImpl, sleep, advance: (ms: number) => (clock += ms) };
}

describe("arxivCategory", () => {
  it("reads the category from the feed URL and the API URL", () => {
    expect(arxivCategory("https://rss.arxiv.org/rss/cs.AI")).toBe("cs.AI");
    expect(arxivCategory("https://export.arxiv.org/api/query?search_query=cat:cs.CL")).toBe(
      "cs.CL",
    );
  });

  it("rejects other URLs", () => {
    expect(() => arxivCategory("https://example.com/feed")).toThrow(/category/);
  });
});

describe("ArxivFetcher", () => {
  it("queries the official API, newest first", async () => {
    const { fetcher, fetchImpl } = makeFetcher([xml]);
    await fetcher.fetch(source, null);
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe(arxivApiUrl("cs.HC", 0));
    expect(url).toContain("export.arxiv.org/api/query");
    expect(url).toContain("sortOrder=descending");
  });

  it("maps title, authors, abstract, link and date", async () => {
    const { fetcher } = makeFetcher([xml]);
    const result = await fetcher.fetch(source, null);
    expect(result.items).toHaveLength(3);
    const first = result.items[0]!;
    expect(first.title).toMatch(/^MidasTUI/);
    expect(first.url).toBe("https://arxiv.org/abs/2611.34945");
    expect(first.text).toContain("Authors: Wen Ying, Xuweiyi Chen, Zezhou Cheng, Seongkook Heo");
    expect(first.text).toContain("While wearable displays");
    expect(first.publishedAt?.toISOString()).toBe("2026-11-25T18:59:59.000Z");
    expect(first.language).toBe("en");
  });

  it("keeps only papers newer than `since`", async () => {
    const { fetcher } = makeFetcher([xml]);
    const result = await fetcher.fetch(source, new Date("2026-11-25T17:00:00Z"));
    expect(result.items.map((i) => i.url)).toEqual(["https://arxiv.org/abs/2611.34945"]);
  });

  it("does not return the same paper twice", async () => {
    const { fetcher } = makeFetcher([xml.replace(/2611\.34673v1/g, "2611.34945v2")]);
    const result = await fetcher.fetch(source, null);
    const urls = result.items.map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("waits at least 3 seconds between requests", async () => {
    const full = Array.from({ length: 100 }, () => xml.match(/<entry>[\s\S]*?<\/entry>/)![0]);
    const page = xml.replace(/<entry>[\s\S]*<\/entry>/, full.join("\n"));
    const { fetcher, sleep, advance } = makeFetcher([page, xml]);
    advance(1);
    await fetcher.fetch(source, new Date("2020-01-01T00:00:00Z"));
    expect(sleep).toHaveBeenCalledWith(3000);
  });
});
