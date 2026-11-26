import { httpGet, type HttpOptions } from "./http.js";
import type { FetchResult, FetchSource, Fetcher, RawItem } from "./types.js";

/** Minimum time between two requests to t.me. Default: 2000 ms. */
const MIN_REQUEST_GAP_MS = 2000;
const MAX_TITLE_LENGTH = 120;
/** Maximum number of preview pages per fetch. A page has about 20 posts. */
const DEFAULT_MAX_PAGES = 10;

const MESSAGE_SPLIT = /<div class="tgme_widget_message_wrap/;
const POST_ID = /data-post="([A-Za-z0-9_]+)\/(\d+)"/;
const POST_DATE = /<a class="tgme_widget_message_date"[^>]*>\s*<time[^>]*datetime="([^"]+)"/;
const TEXT_START = /<div class="tgme_widget_message_text js-message_text"[^>]*>/g;
const LINK_PREVIEW = /<a class="tgme_widget_message_link_preview"[^>]*href="([^"]+)"/;
const OLDER_PAGE = /<a [^>]*class="tme_messages_more[^"]*"[^>]*data-before="(\d+)"/;
const ANCHOR = /<a\s[^>]*href="([^"]+)"/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1]!.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Convert the HTML of a post text to plain text. Line breaks stay. */
function htmlToText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  const plain = decodeEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return plain
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True for an absolute http(s) URL that does not point to Telegram. */
function isExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return !(host === "t.me" || host.endsWith(".t.me") || host === "telegram.me");
}

function firstExternalUrl(html: string): string | null {
  for (const match of html.matchAll(ANCHOR)) {
    const href = decodeEntities(match[1]!);
    if (isExternalUrl(href)) return href;
  }
  return null;
}

export interface TelegramPost {
  channel: string;
  id: number;
  permalink: string;
  publishedAt: Date;
  text: string;
  /** First link in the post that does not point to Telegram. */
  externalUrl: string | null;
}

export interface ParsedPreview {
  /** Posts that have a text or an external link. */
  posts: TelegramPost[];
  /** Value of `?before=` for the next older page, or null on the oldest page. */
  olderBefore: number | null;
  /** Number of message blocks found in the HTML. */
  messageBlocks: number;
  /** Number of message blocks without an id or a date. A high number means a layout change. */
  malformedBlocks: number;
}

/** Parse the HTML of `https://t.me/s/<channel>`. Posts are in page order, oldest first. */
export function parseTelegramPreview(html: string): ParsedPreview {
  const blocks = html.split(MESSAGE_SPLIT).slice(1);
  const posts: TelegramPost[] = [];
  let malformedBlocks = 0;
  for (const block of blocks) {
    const idMatch = POST_ID.exec(block);
    const dateMatch = POST_DATE.exec(block);
    const publishedAt = dateMatch ? new Date(dateMatch[1]!) : null;
    if (!idMatch || !publishedAt || Number.isNaN(publishedAt.getTime())) {
      malformedBlocks++;
      continue;
    }
    // A text block can be nested inside another one. The last start tag is the inner block.
    const starts = [...block.matchAll(TEXT_START)];
    const last = starts.at(-1);
    let textHtml = "";
    if (last) {
      const from = last.index + last[0].length;
      const end = block.indexOf("</div>", from);
      textHtml = block.slice(from, end === -1 ? undefined : end);
    }
    const text = htmlToText(textHtml);
    const externalUrl =
      firstExternalUrl(textHtml) ??
      (() => {
        const preview = LINK_PREVIEW.exec(block)?.[1];
        const href = preview ? decodeEntities(preview) : null;
        return href && isExternalUrl(href) ? href : null;
      })();
    if (!text && !externalUrl) continue; // Media without a caption.
    const channel = idMatch[1]!;
    const id = Number(idMatch[2]);
    posts.push({
      channel,
      id,
      permalink: `https://t.me/${channel}/${id}`,
      publishedAt,
      text,
      externalUrl,
    });
  }
  const older = OLDER_PAGE.exec(html)?.[1];
  const olderBefore = older ? Number(older) : null;
  return { posts, olderBefore, messageBlocks: blocks.length, malformedBlocks };
}

function makeTitle(text: string): string {
  const line = text.split("\n").find((l) => l.length > 0) ?? "";
  return line.length > MAX_TITLE_LENGTH
    ? `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : line;
}

export interface TelegramWebOptions {
  http: HttpOptions;
  /** Minimum time between two requests. Default: 2000 ms. */
  minRequestGapMs?: number;
  now?: () => number;
  /** Maximum number of pages per fetch. Default: 10. */
  maxPages?: number;
}

/**
 * Reads the public web preview of a Telegram channel (`https://t.me/s/<channel>`).
 * No account is needed. The item URL is the external link of the post when there is one.
 * Otherwise it is the post permalink. The permalink is always in `metadata.telegram`.
 * The fetcher keeps no state. The collector filters by `since` and the database rejects repeated URLs.
 * When `since` is set, it follows the older pages (`?before=<id>`) until a post older than `since`
 * appears or the history ends. It throws when the page limit is reached before that.
 * It throws when the first page has no posts, so a layout change or a disabled preview is never silent.
 */
export class TelegramWebFetcher implements Fetcher {
  private lastRequestAt: number | null = null;

  constructor(private readonly options: TelegramWebOptions) {}

  private async throttle(): Promise<void> {
    const now = this.options.now ?? Date.now;
    const gap = this.options.minRequestGapMs ?? MIN_REQUEST_GAP_MS;
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + gap - now();
      if (wait > 0) {
        const sleep =
          this.options.http.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        await sleep(wait);
      }
    }
    this.lastRequestAt = now();
  }

  async fetch(source: FetchSource, since: Date | null): Promise<FetchResult> {
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;
    const collected: TelegramPost[] = [];
    const seen = new Set<number>();
    let pageUrl = source.url;
    let previousBefore = Number.POSITIVE_INFINITY;
    for (let page = 1; ; page++) {
      const response = await httpGet(
        pageUrl,
        {},
        { ...this.options.http, beforeAttempt: () => this.throttle() },
      );
      const parsed = parseTelegramPreview(response.body);
      if (page === 1) {
        if (parsed.messageBlocks === 0) {
          throw new Error(
            `No posts found in ${source.url}. The web preview may be disabled or the layout changed.`,
          );
        }
        if (parsed.malformedBlocks === parsed.messageBlocks) {
          throw new Error(
            `Layout change in ${source.url}: ${parsed.messageBlocks} message blocks, none with a post id and a date.`,
          );
        }
      }
      for (const post of parsed.posts) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        collected.push(post);
      }
      if (since === null) break;
      const reachedCutoff = parsed.posts.some((p) => p.publishedAt < since);
      if (reachedCutoff || parsed.olderBefore === null) break;
      if (parsed.olderBefore >= previousBefore) {
        throw new Error(`Paging does not advance in ${source.url} at ${pageUrl}.`);
      }
      if (page >= maxPages) {
        throw new Error(
          `Page limit ${maxPages} reached in ${source.url} before the cutoff ${since.toISOString()}.`,
        );
      }
      previousBefore = parsed.olderBefore;
      pageUrl = new URL(`?before=${parsed.olderBefore}`, source.url).toString();
    }

    const items: RawItem[] = [];
    for (const post of collected) {
      if (since && post.publishedAt < since) continue;
      items.push({
        url: post.externalUrl ?? post.permalink,
        title: makeTitle(post.text) || post.externalUrl || post.permalink,
        text: post.text || null,
        publishedAt: post.publishedAt,
        language: source.language,
        metadata: {
          telegram: { channel: post.channel, postId: post.id, permalink: post.permalink },
        },
      });
    }
    return { items, notModified: false, etag: null, lastModified: null };
  }
}
