import Parser from "rss-parser";
import { httpGet, type HttpOptions } from "./http.js";
import type { FetchResult, FetchSource, Fetcher, RawItem } from "./types.js";

const API_URL = "https://export.arxiv.org/api/query";
/** arXiv asks for at most one request every 3 seconds. */
const MIN_REQUEST_GAP_MS = 3_000;
const PAGE_SIZE = 100;
/** Hard limit per run: 500 papers. cs.AI has about 400 new papers per day. */
const MAX_PAGES = 5;

type ArxivEntry = Parser.Item & {
  id?: string;
  authors?: { name?: string[] }[] | string[];
  published?: string;
  summary?: string;
};

export interface ArxivOptions {
  http: HttpOptions;
  /** Minimum time between two API requests. Default: 3000 ms. */
  minRequestGapMs?: number;
  now?: () => number;
}

/**
 * Get the arXiv category from a source URL.
 * Accepts the feed form `https://rss.arxiv.org/rss/cs.AI`
 * and the API form `https://export.arxiv.org/api/query?search_query=cat:cs.AI`.
 */
export function arxivCategory(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  const query = url.searchParams.get("search_query");
  const fromQuery = query ? /^cat:([\w.-]+)$/.exec(query)?.[1] : undefined;
  const fromPath = url.pathname.split("/").filter(Boolean).pop();
  const category = fromQuery ?? (url.pathname.startsWith("/rss/") ? fromPath : undefined);
  if (!category || !/^[A-Za-z][\w.-]*$/.test(category)) {
    throw new Error(`Cannot find an arXiv category in URL: ${sourceUrl}`);
  }
  return category;
}

/** Build the API URL: newest submissions first. */
export function arxivApiUrl(category: string, start: number): string {
  const params = new URLSearchParams({
    search_query: `cat:${category}`,
    sortBy: "submittedDate",
    sortOrder: "descending",
    start: String(start),
    max_results: String(PAGE_SIZE),
  });
  return `${API_URL}?${params.toString()}`;
}

/** Remove the version suffix, so v1 and v2 of a paper give the same URL. */
function abstractUrl(entry: ArxivEntry): string | null {
  const raw = entry.id?.trim() ?? entry.link?.trim();
  if (!raw) return null;
  const match = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/.exec(raw);
  return match ? `https://arxiv.org/abs/${match[1]}` : raw;
}

function authorNames(entry: ArxivEntry): string[] {
  const authors = entry.authors ?? [];
  return authors
    .flatMap((author) => (typeof author === "string" ? [author] : (author.name ?? [])))
    .map((name) => name.trim())
    .filter(Boolean);
}

export class ArxivFetcher implements Fetcher {
  private readonly parser = new Parser({
    customFields: {
      item: [
        ["id", "id"],
        ["published", "published"],
        ["author", "authors", { keepArray: true }],
      ],
    },
  });
  private readonly gapMs: number;
  private readonly now: () => number;
  private lastRequestAt: number | null = null;

  constructor(private readonly options: ArxivOptions) {
    this.gapMs = options.minRequestGapMs ?? MIN_REQUEST_GAP_MS;
    this.now = options.now ?? Date.now;
  }

  /** Wait until the gap since the last request has passed. */
  private async throttle(): Promise<void> {
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + this.gapMs - this.now();
      if (wait > 0) {
        const sleep =
          this.options.http.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        await sleep(wait);
      }
    }
    this.lastRequestAt = this.now();
  }

  async fetch(source: FetchSource, since: Date | null): Promise<FetchResult> {
    const category = arxivCategory(source.url);
    const items: RawItem[] = [];
    const seen = new Set<string>();

    // Without `since` (first run) we read one page only. That avoids a large first load.
    const maxPages = since ? MAX_PAGES : 1;
    for (let page = 0; page < maxPages; page++) {
      await this.throttle();
      // The API has no useful validators, so we send none.
      const response = await httpGet(
        arxivApiUrl(category, page * PAGE_SIZE),
        {},
        this.options.http,
      );
      const feed = await this.parser.parseString(response.body);
      const entries = feed.items as ArxivEntry[];
      let reachedOld = false;

      for (const entry of entries) {
        const url = abstractUrl(entry);
        const title = entry.title?.replace(/\s+/g, " ").trim();
        if (!url || !title) continue;
        const publishedRaw = entry.published ?? entry.isoDate ?? entry.pubDate;
        const parsed = publishedRaw ? new Date(publishedRaw) : null;
        const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
        if (since && publishedAt && publishedAt < since) {
          reachedOld = true;
          continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        const abstract = (entry.summary ?? entry.content ?? "").replace(/\s+/g, " ").trim();
        const authors = authorNames(entry);
        const text = [authors.length > 0 ? `Authors: ${authors.join(", ")}` : "", abstract]
          .filter(Boolean)
          .join("\n\n");
        items.push({ url, title, text: text || null, publishedAt, language: source.language });
      }
      if (reachedOld || entries.length < PAGE_SIZE) break;
    }
    return { items, notModified: false, etag: null, lastModified: null };
  }
}
