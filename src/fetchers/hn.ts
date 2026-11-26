import { httpGet, type HttpOptions } from "./http.js";
import type { FetchResult, FetchSource, Fetcher, RawItem } from "./types.js";
import { z } from "zod";

const hnItemSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  score: z.number().optional(),
  time: z.number().optional(),
  descendants: z.number().optional(),
  by: z.string().optional(),
  dead: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const idListSchema = z.array(z.number());

export interface HnOptions {
  http: HttpOptions;
  /** Keep only stories with at least this score. */
  minScore: number;
  /** How many stories from the top of the list to check. */
  limit?: number;
  /** Parallel requests for single stories. */
  concurrency?: number;
}

export const HN_DISCUSSION_URL = "https://news.ycombinator.com/item?id=";

/**
 * Reads the official Hacker News API (Firebase).
 * `source.url` is a list endpoint, for example `.../v0/topstories.json` or `.../v0/beststories.json`.
 * The item URL is the linked article. The discussion goes to `metadata`.
 */
export class HnFetcher implements Fetcher {
  constructor(private readonly options: HnOptions) {}

  async fetch(source: FetchSource, since: Date | null): Promise<FetchResult> {
    const { http, minScore } = this.options;
    const limit = this.options.limit ?? 60;
    const concurrency = this.options.concurrency ?? 8;
    const itemBase = source.url.replace(/[^/]+$/, "item/");

    const list = await httpGet(source.url, {}, http);
    const ids = idListSchema.parse(JSON.parse(list.body)).slice(0, limit);

    const items: RawItem[] = [];
    let failures = 0;
    let lastError: unknown = null;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          const item = await this.fetchStory(`${itemBase}${id}.json`, minScore, since, source);
          if (item) items.push(item);
        } catch (error) {
          // One bad story must not fail the whole source.
          failures++;
          lastError = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    // If every story request failed, report a failure so the collector does not mark the source healthy.
    if (ids.length > 0 && failures === ids.length) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`All ${ids.length} Hacker News story requests failed: ${reason}`);
    }

    return { items, notModified: false, etag: null, lastModified: null };
  }

  private async fetchStory(
    url: string,
    minScore: number,
    since: Date | null,
    source: FetchSource,
  ): Promise<RawItem | null> {
    // Throws when the request or the JSON parsing fails. The caller counts these failures.
    const response = await httpGet(url, {}, this.options.http);
    const parsed = hnItemSchema.safeParse(JSON.parse(response.body));
    if (!parsed.success) return null;
    const story = parsed.data;
    if (story.type !== "story" || story.dead || story.deleted) return null;
    const title = story.title?.trim();
    if (!title) return null;
    const score = story.score ?? 0;
    if (score < minScore) return null;
    const publishedAt = story.time ? new Date(story.time * 1000) : null;
    if (since && publishedAt && publishedAt < since) return null;
    const discussionUrl = `${HN_DISCUSSION_URL}${story.id}`;
    return {
      // Stories without a link (for example Ask HN) use the discussion as the item URL.
      url: story.url?.trim() || discussionUrl,
      title,
      text: null,
      publishedAt,
      language: source.language,
      metadata: {
        hn: {
          id: story.id,
          discussionUrl,
          score,
          comments: story.descendants ?? 0,
          author: story.by ?? null,
        },
      },
    };
  }
}
