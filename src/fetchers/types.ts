/** One item as a fetcher returns it, before normalization. */
export interface RawItem {
  url: string;
  title: string;
  text: string | null;
  publishedAt: Date | null;
  language: string;
  /** Extra source-specific data, for example the Hacker News discussion. */
  metadata?: Record<string, unknown>;
}

/** The part of a `sources` row that a fetcher needs. */
export interface FetchSource {
  slug: string;
  type: string;
  url: string;
  language: string;
  /** ETag from the last successful response, if any. */
  etag: string | null;
  /** Last-Modified header from the last successful response, if any. */
  lastModified: string | null;
}

export interface FetchResult {
  /** Items newer than `since`. Items without a date are always kept. */
  items: RawItem[];
  /** True when the server answered 304. Then `items` is empty. */
  notModified: boolean;
  /** Validators to store for the next conditional request. */
  etag: string | null;
  lastModified: string | null;
}

export interface Fetcher {
  fetch(source: FetchSource, since: Date | null): Promise<FetchResult>;
}
