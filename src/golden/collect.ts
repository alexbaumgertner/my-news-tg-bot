import type { Logger } from "pino";
import type { Source } from "../config.js";
import { ArxivFetcher } from "../fetchers/arxiv.js";
import { HnFetcher } from "../fetchers/hn.js";
import type { HttpOptions } from "../fetchers/http.js";
import { PubmedFetcher } from "../fetchers/pubmed.js";
import { RssFetcher } from "../fetchers/rss.js";
import { TelegramWebFetcher } from "../fetchers/telegram-web.js";
import type { Fetcher } from "../fetchers/types.js";
import { Normalizer } from "../pipeline/normalize.js";
import { POOL_PER_SOURCE, sampleCandidates, type CandidateRow, type PoolItem } from "./export.js";

export interface CollectOptions {
  sources: Source[];
  perSource: number;
  seed: number;
  userAgent: string;
  ncbiApiKey?: string;
  hnMinScore: number;
  logger: Logger;
  /** Replace the fetchers in tests. */
  fetchers?: Record<string, Fetcher>;
  normalizer?: Pick<Normalizer, "normalizeAll">;
}

/** Fetchers for the source types that the collector supports. No database is needed. */
export function createFetchers(options: CollectOptions): Record<string, Fetcher> {
  const http: HttpOptions = { userAgent: options.userAgent };
  return {
    rss: new RssFetcher(http),
    arxiv: new ArxivFetcher({ http }),
    pubmed: new PubmedFetcher({ http, apiKey: options.ncbiApiKey }),
    hn: new HnFetcher({ http, minScore: options.hnMinScore }),
    telegram_web: new TelegramWebFetcher({ http }),
  };
}

/**
 * Fetch every active source, sample the candidates and normalize them.
 * A failing source is logged and skipped. Only the sampled items are normalized,
 * so the run makes few page requests.
 */
export async function collectCandidates(options: CollectOptions): Promise<CandidateRow[]> {
  const { logger } = options;
  const fetchers = options.fetchers ?? createFetchers(options);
  const pool: PoolItem[] = [];
  for (const source of options.sources) {
    if (!source.active) continue;
    const fetcher = fetchers[source.type];
    if (!fetcher) {
      logger.warn({ source: source.id, type: source.type }, "No fetcher for this type. Skipped.");
      continue;
    }
    try {
      const result = await fetcher.fetch(
        {
          slug: source.id,
          type: source.type,
          url: source.url,
          language: source.language,
          etag: null,
          lastModified: null,
          initialLookbackDays: source.initial_lookback_days ?? null,
        },
        null,
      );
      for (const raw of result.items.slice(0, POOL_PER_SOURCE)) {
        pool.push({ source: source.id, raw });
      }
      logger.info({ source: source.id, items: result.items.length }, "Source fetched");
    } catch (error) {
      logger.warn({ source: source.id, err: error }, "Source failed. Continuing.");
    }
  }

  const picked = sampleCandidates(pool, { perSource: options.perSource, seed: options.seed });
  const normalizer = options.normalizer ?? new Normalizer({ userAgent: options.userAgent });
  const normalized = await normalizer.normalizeAll(picked.map((entry) => entry.raw));
  return picked.map((entry, index) => ({
    source: entry.source,
    item: normalized[index] as CandidateRow["item"],
  }));
}
