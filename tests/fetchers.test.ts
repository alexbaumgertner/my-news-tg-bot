import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { httpGet } from "../src/fetchers/http.js";
import { canonicalizeUrl, contentHash } from "../src/fetchers/normalize.js";
import { RssFetcher } from "../src/fetchers/rss.js";
import { parsePollInterval } from "../src/fetchers/collector.js";
import type { FetchSource } from "../src/fetchers/types.js";

const rssXml = readFileSync("tests/fixtures/rss.xml", "utf8");
const atomXml = readFileSync("tests/fixtures/atom.xml", "utf8");

const source: FetchSource = {
  slug: "example",
  type: "rss",
  url: "https://example.com/feed",
  language: "en",
  etag: null,
  lastModified: null,
};

const noSleep = async () => {};

function fakeFetch(...responses: (Response | Error)[]) {
  const mock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return mock as unknown as typeof fetch & typeof mock;
}

describe("httpGet", () => {
  it("sends user agent and conditional headers", async () => {
    const fetchImpl = fakeFetch(new Response("ok", { headers: { etag: '"b"' } }));
    const result = await httpGet(
      "https://example.com/feed",
      { etag: '"a"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" },
      { userAgent: "test-agent", fetchImpl, sleep: noSleep },
    );
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("test-agent");
    expect(headers["If-None-Match"]).toBe('"a"');
    expect(headers["If-Modified-Since"]).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
    expect(result.etag).toBe('"b"');
  });

  it("returns 304 and keeps the old validators", async () => {
    const fetchImpl = fakeFetch(new Response(null, { status: 304 }));
    const result = await httpGet(
      "https://example.com/feed",
      { etag: '"a"' },
      {
        userAgent: "t",
        fetchImpl,
        sleep: noSleep,
      },
    );
    expect(result.status).toBe(304);
    expect(result.etag).toBe('"a"');
  });

  it("retries on 503 and on network errors, then succeeds", async () => {
    const fetchImpl = fakeFetch(
      new Response("no", { status: 503 }),
      new Error("socket hang up"),
      new Response("fine"),
    );
    const sleep = vi.fn(noSleep);
    const result = await httpGet(
      "https://example.com/feed",
      {},
      {
        userAgent: "t",
        fetchImpl,
        sleep,
        baseDelayMs: 10,
      },
    );
    expect(result.body).toBe("fine");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((sleep.mock.calls as unknown as number[][]).map((c) => c[0])).toEqual([10, 20]);
  });

  it("does not retry a 404", async () => {
    const fetchImpl = fakeFetch(new Response("missing", { status: 404 }));
    await expect(
      httpGet("https://example.com/feed", {}, { userAgent: "t", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after max attempts", async () => {
    const fetchImpl = fakeFetch(
      new Response("", { status: 500 }),
      new Response("", { status: 500 }),
    );
    await expect(
      httpGet(
        "https://example.com/feed",
        {},
        {
          userAgent: "t",
          fetchImpl,
          sleep: noSleep,
          maxAttempts: 2,
        },
      ),
    ).rejects.toThrow("HTTP 500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("RssFetcher", () => {
  it("parses RSS, skips entries without a link and keeps all dates when since is null", async () => {
    const fetcher = new RssFetcher({
      userAgent: "t",
      fetchImpl: fakeFetch(new Response(rssXml, { headers: { etag: '"v1"' } })),
      sleep: noSleep,
    });
    const result = await fetcher.fetch(source, null);
    expect(result.items.map((i) => i.title)).toEqual(["New story", "Old story"]);
    expect(result.items[0]?.text).toBe("Short summary.");
    expect(result.items[1]?.text).toBe("<p>Full body.</p>");
    expect(result.items[0]?.language).toBe("en");
    expect(result.etag).toBe('"v1"');
  });

  it("drops items older than since", async () => {
    const fetcher = new RssFetcher({
      userAgent: "t",
      fetchImpl: fakeFetch(new Response(rssXml)),
      sleep: noSleep,
    });
    const result = await fetcher.fetch(source, new Date("2026-01-01T00:00:00Z"));
    expect(result.items.map((i) => i.title)).toEqual(["New story"]);
  });

  it("parses Atom", async () => {
    const fetcher = new RssFetcher({
      userAgent: "t",
      fetchImpl: fakeFetch(new Response(atomXml)),
      sleep: noSleep,
    });
    const result = await fetcher.fetch(source, null);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe("https://example.com/atom-1");
    expect(result.items[0]?.publishedAt?.toISOString()).toBe("2026-11-25T10:00:00.000Z");
  });

  it("reports not modified on 304", async () => {
    const fetcher = new RssFetcher({
      userAgent: "t",
      fetchImpl: fakeFetch(new Response(null, { status: 304 })),
      sleep: noSleep,
    });
    const result = await fetcher.fetch({ ...source, etag: '"v1"' }, null);
    expect(result).toMatchObject({ notModified: true, items: [], etag: '"v1"' });
  });

  it("rejects invalid XML", async () => {
    const fetcher = new RssFetcher({
      userAgent: "t",
      fetchImpl: fakeFetch(new Response("<html>not a feed")),
      sleep: noSleep,
    });
    await expect(fetcher.fetch(source, null)).rejects.toThrow();
  });
});

describe("normalize", () => {
  it("removes tracking parameters, fragment and trailing slash", () => {
    expect(canonicalizeUrl("https://Example.com/a/?utm_source=x&b=2&a=1#top")).toBe(
      "https://example.com/a?a=1&b=2",
    );
  });

  it("gives the same hash for the same content", () => {
    expect(contentHash("Title", " Body  text")).toBe(contentHash("title", "body text"));
    expect(contentHash("Title", null)).not.toBe(contentHash("Other", null));
  });
});

describe("parsePollInterval", () => {
  it("converts units", () => {
    expect(parsePollInterval("30m")).toBe(1_800_000);
    expect(parsePollInterval("2h")).toBe(7_200_000);
    expect(parsePollInterval("1d")).toBe(86_400_000);
    expect(() => parsePollInterval("2x")).toThrow();
  });
});
