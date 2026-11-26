import Parser from "rss-parser";
import { httpGet, type HttpOptions } from "./http.js";
import type { FetchResult, FetchSource, Fetcher, RawItem } from "./types.js";

type FeedItem = Parser.Item & { "content:encoded"?: string; summary?: string };

function parseDate(item: Parser.Item): Date | null {
  const value = item.isoDate ?? item.pubDate;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class RssFetcher implements Fetcher {
  private readonly parser = new Parser();

  constructor(private readonly http: HttpOptions) {}

  async fetch(source: FetchSource, since: Date | null): Promise<FetchResult> {
    const response = await httpGet(
      source.url,
      { etag: source.etag, lastModified: source.lastModified },
      this.http,
    );
    if (response.status === 304) {
      return {
        items: [],
        notModified: true,
        etag: response.etag,
        lastModified: response.lastModified,
      };
    }
    const feed = await this.parser.parseString(response.body);
    const items: RawItem[] = [];
    for (const entry of feed.items as FeedItem[]) {
      const url = entry.link?.trim();
      const title = entry.title?.trim();
      if (!url || !title) continue;
      const publishedAt = parseDate(entry);
      if (since && publishedAt && publishedAt < since) continue;
      const text = (entry["content:encoded"] ?? entry.content ?? entry.summary ?? null)?.trim();
      items.push({
        url,
        title,
        text: text || null,
        publishedAt,
        language: source.language,
      });
    }
    return { items, notModified: false, etag: response.etag, lastModified: response.lastModified };
  }
}
