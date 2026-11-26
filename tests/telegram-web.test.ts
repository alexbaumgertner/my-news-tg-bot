import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseTelegramPreview, TelegramWebFetcher } from "../src/fetchers/telegram-web.js";
import type { FetchSource } from "../src/fetchers/types.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/telegram/${name}.html`, "utf8");

function source(channel: string, language = "en"): FetchSource {
  return {
    slug: `tg-${channel}`,
    type: "telegram_web",
    url: `https://t.me/s/${channel}`,
    language,
    etag: null,
    lastModified: null,
  };
}

function makeFetcher(body: string, status = 200) {
  const fetchImpl = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
  const fetcher = new TelegramWebFetcher({
    http: { userAgent: "test-agent", fetchImpl, maxAttempts: 1 },
    minRequestGapMs: 0,
  });
  return { fetcher, fetchImpl };
}

describe("parseTelegramPreview", () => {
  it("parses id, date, text and permalink of every post", () => {
    const { posts, messageBlocks, malformedBlocks } = parseTelegramPreview(
      fixture("zakat_podcast"),
    );
    expect(messageBlocks).toBe(15);
    expect(malformedBlocks).toBe(0);
    expect(posts).toHaveLength(15);
    const first = posts[0]!;
    expect(first.id).toBe(5245);
    expect(first.permalink).toBe("https://t.me/zakat_podcast/5245");
    expect(first.publishedAt).toEqual(new Date("2026-11-11T14:25:46+00:00"));
    expect(first.text).toBe("Курорт Моркам в Великобритании, 1900-й год\n\n#зи_фото");
  });

  it("finds the external link in the post text", () => {
    const { posts } = parseTelegramPreview(fixture("zakat_podcast"));
    expect(posts.find((p) => p.id === 5247)!.externalUrl).toBe("http://vitriolmag.ru/");
  });

  it("does not treat t.me links as external", () => {
    const { posts } = parseTelegramPreview(fixture("itsallinenglish"));
    expect(posts).toHaveLength(7);
    expect(posts.every((p) => p.externalUrl === null)).toBe(true);
  });

  it("reads the inner text of a nested text block", () => {
    const { posts } = parseTelegramPreview(fixture("itsallinenglish"));
    expect(posts[0]!.text.startsWith("Psychologies UK - December 2026")).toBe(true);
  });

  it("finds no message blocks when the preview is disabled", () => {
    expect(parseTelegramPreview(fixture("preview_disabled")).messageBlocks).toBe(0);
  });
});

describe("TelegramWebFetcher", () => {
  it("returns items with the external link as URL and the permalink in metadata", async () => {
    const { fetcher } = makeFetcher(fixture("zakat_podcast"));
    const result = await fetcher.fetch(source("zakat_podcast", "ru"), null);
    expect(result.items).toHaveLength(15);
    const linked = result.items.find((i) => i.url === "http://vitriolmag.ru/")!;
    expect(linked.language).toBe("ru");
    expect(linked.metadata).toEqual({
      telegram: {
        channel: "zakat_podcast",
        postId: 5247,
        permalink: "https://t.me/zakat_podcast/5247",
      },
    });
    const plain = result.items.find((i) => i.url === "https://t.me/zakat_podcast/5245")!;
    expect(plain.title).toBe("Курорт Моркам в Великобритании, 1900-й год");
  });

  it("collects posts of itsallinenglish with permalinks as URLs", async () => {
    const { fetcher } = makeFetcher(fixture("itsallinenglish"));
    const result = await fetcher.fetch(source("itsallinenglish"), null);
    expect(result.items).toHaveLength(7);
    expect(result.items[0]!.url).toBe("https://t.me/itsallinenglish/26541");
    expect(result.items[0]!.title).toBe("Psychologies UK - December 2026");
  });

  it("drops posts older than `since`", async () => {
    const { fetcher } = makeFetcher(fixture("zakat_podcast"));
    const all = await fetcher.fetch(source("zakat_podcast"), null);
    const since = all.items[10]!.publishedAt!;
    const result = await fetcher.fetch(source("zakat_podcast"), since);
    expect(result.items.length).toBeLessThan(all.items.length);
    expect(result.items.every((i) => i.publishedAt! >= since)).toBe(true);
  });

  it("returns the same items on a second run, so the database can reject repeats", async () => {
    const { fetcher } = makeFetcher(fixture("zakat_podcast"));
    const a = await fetcher.fetch(source("zakat_podcast"), null);
    const b = await fetcher.fetch(source("zakat_podcast"), null);
    expect(b.items.map((i) => i.url)).toEqual(a.items.map((i) => i.url));
  });

  it("sends the custom User-Agent", async () => {
    const { fetcher, fetchImpl } = makeFetcher(fixture("zakat_podcast"));
    await fetcher.fetch(source("zakat_podcast"), null);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
  });

  it("fails loudly when the preview is disabled", async () => {
    const { fetcher } = makeFetcher(fixture("preview_disabled"));
    await expect(fetcher.fetch(source("dbibliothek"), null)).rejects.toThrow(/No posts found/);
  });

  it("fails loudly when the layout changes", async () => {
    const changed = fixture("zakat_podcast")
      .replace(/data-post=/g, "data-pst=")
      .replace(/tgme_widget_message_date/g, "tgme_widget_msg_date");
    const { fetcher } = makeFetcher(changed);
    await expect(fetcher.fetch(source("zakat_podcast"), null)).rejects.toThrow(/Layout change/);
  });

  it("throws on an HTTP error", async () => {
    const { fetcher } = makeFetcher("nope", 404);
    await expect(fetcher.fetch(source("zakat_podcast"), null)).rejects.toThrow(/HTTP 404/);
  });

  it("waits between two requests", async () => {
    const sleep = vi.fn(async () => {});
    let clock = 1000;
    const fetcher = new TelegramWebFetcher({
      http: {
        userAgent: "t",
        maxAttempts: 1,
        sleep,
        fetchImpl: (async () => new Response(fixture("zakat_podcast"))) as typeof fetch,
      },
      minRequestGapMs: 2000,
      now: () => clock,
    });
    await fetcher.fetch(source("a"), null);
    clock += 500;
    await fetcher.fetch(source("b"), null);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  describe("paging", () => {
    const channel = "zakat_podcast";
    const html = fixture("zakat_podcast");
    const posts = parseTelegramPreview(html).posts;

    /** Make an older page from the fixture: shift ids and dates back by `days`. */
    function olderPage(days: number, olderBefore: number | null): string {
      let page = html
        .replace(
          /data-post="zakat_podcast\/(\d+)"/g,
          (_m, id) => `data-post="zakat_podcast/${Number(id) - 100 * days}"`,
        )
        .replace(/datetime="([^"]+)"/g, (_m, d: string) => {
          const date = new Date(new Date(d).getTime() - days * 86_400_000);
          return `datetime="${date.toISOString()}"`;
        });
      page = page.replace(
        /data-before="\d+"/,
        olderBefore === null ? "" : `data-before="${olderBefore}"`,
      );
      return olderBefore === null ? page.replace(/class="tme_messages_more[^"]*"/, "") : page;
    }

    function pagedFetcher(pages: string[], maxPages?: number) {
      const urls: string[] = [];
      const fetchImpl = (async (url: string) => {
        urls.push(url);
        return new Response(pages[urls.length - 1] ?? pages[pages.length - 1]);
      }) as unknown as typeof fetch;
      const fetcher = new TelegramWebFetcher({
        http: { userAgent: "t", fetchImpl, maxAttempts: 1 },
        minRequestGapMs: 0,
        ...(maxPages ? { maxPages } : {}),
      });
      return { fetcher, urls };
    }

    it("reads only the first page without `since`", async () => {
      const { fetcher, urls } = pagedFetcher([html]);
      await fetcher.fetch(source(channel), null);
      expect(urls).toEqual([`https://t.me/s/${channel}`]);
    });

    it("follows the older page when every post of the first page is newer than `since`", async () => {
      const since = new Date(posts[0]!.publishedAt.getTime() - 3 * 86_400_000);
      const { fetcher, urls } = pagedFetcher([html, olderPage(10, null)]);
      const result = await fetcher.fetch(source(channel), since);
      expect(urls).toEqual([`https://t.me/s/${channel}`, `https://t.me/s/${channel}?before=5245`]);
      expect(result.items.length).toBeGreaterThan(15);
      expect(result.items.every((i) => i.publishedAt! >= since)).toBe(true);
    });

    it("stops at the cutoff and does not request more pages", async () => {
      const since = new Date(posts[5]!.publishedAt);
      const { fetcher, urls } = pagedFetcher([html, olderPage(10, null)]);
      await fetcher.fetch(source(channel), since);
      expect(urls).toHaveLength(1);
    });

    it("stops when the history is exhausted", async () => {
      const since = new Date(0);
      const { fetcher, urls } = pagedFetcher([html.replace(/data-before="\d+"/, "")]);
      const result = await fetcher.fetch(source(channel), since);
      expect(urls).toHaveLength(1);
      expect(result.items).toHaveLength(15);
    });

    it("fails loudly when the page limit is reached before the cutoff", async () => {
      const since = new Date(0);
      const pages = [html, olderPage(10, 4000), olderPage(20, 3000), olderPage(30, 2000)];
      const { fetcher, urls } = pagedFetcher(pages, 3);
      await expect(fetcher.fetch(source(channel), since)).rejects.toThrow(/Page limit 3/);
      expect(urls).toHaveLength(3);
    });

    it("fails loudly when the older link does not advance", async () => {
      const since = new Date(0);
      const { fetcher } = pagedFetcher([html, html]);
      await expect(fetcher.fetch(source(channel), since)).rejects.toThrow(/does not advance/);
    });

    it("fails loudly when an older page is a disabled preview", async () => {
      const since = new Date(0);
      const { fetcher, urls } = pagedFetcher([html, fixture("preview_disabled")]);
      await expect(fetcher.fetch(source(channel), since)).rejects.toThrow(/No posts found/);
      expect(urls).toHaveLength(2);
    });

    it("waits between page requests", async () => {
      const sleep = vi.fn(async () => {});
      const pages = [html, olderPage(10, null)];
      let n = 0;
      const fetcher = new TelegramWebFetcher({
        http: {
          userAgent: "t",
          maxAttempts: 1,
          sleep,
          fetchImpl: (async () => new Response(pages[n++]!)) as typeof fetch,
        },
        minRequestGapMs: 2000,
        now: () => 1000,
      });
      await fetcher.fetch(source(channel), new Date(0));
      expect(sleep).toHaveBeenCalledWith(2000);
    });
  });
});
