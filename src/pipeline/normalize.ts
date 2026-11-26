import { Readability } from "@mozilla/readability";
import { franc } from "franc-min";
import { parseHTML } from "linkedom";
import { canonicalizeUrl, contentHash } from "../fetchers/normalize.js";
import type { RawItem } from "../fetchers/types.js";
import { RobotsCache } from "./robots.js";

/** An item after normalization. All fields are set. */
export interface NormalizedItem {
  url: string;
  canonicalUrl: string;
  title: string;
  text: string | null;
  language: string;
  contentHash: string;
  publishedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface NormalizeOptions {
  userAgent: string;
  /** Maximum characters of text to keep per item. */
  maxTextChars?: number;
  /** A feed text shorter than this is a snippet. Then we fetch the page. */
  snippetMaxChars?: number;
  /** Items processed at the same time. Keep it small to save memory. */
  batchSize?: number;
  /** Maximum bytes to read from one page. */
  maxPageBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_MAX_TEXT_CHARS = 20_000;
export const DEFAULT_SNIPPET_MAX_CHARS = 600;
export const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_PAGE_BYTES = 2_000_000;
const MIN_LANGUAGE_CHARS = 20;

/** Map ISO 639-3 codes from franc to ISO 639-1 codes. Other languages map to "und" (unknown). */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en",
  rus: "ru",
  tur: "tr",
  ukr: "uk",
  deu: "de",
  fra: "fr",
  spa: "es",
  ita: "it",
  por: "pt",
  nld: "nl",
  pol: "pl",
  ces: "cs",
  arb: "ar",
  cmn: "zh",
  jpn: "ja",
  kor: "ko",
};

/** Detect the language of a text. Return `fallback` when the text is too short or unclear. */
export function detectLanguage(text: string, fallback: string): string {
  const sample = text.slice(0, 2_000).trim();
  if (sample.length < MIN_LANGUAGE_CHARS) return fallback;
  const code = franc(sample, { minLength: MIN_LANGUAGE_CHARS });
  return ISO3_TO_ISO1[code] ?? fallback;
}

/** Remove tags and collapse white space. Feed snippets often contain HTML. */
export function cleanText(input: string, maxChars: number): string {
  const stripped = /<[a-z!/][^>]*>/i.test(input)
    ? input
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    : input;
  const collapsed = stripped
    .replace(/[ \t\f\v\u00A0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars).trimEnd() : collapsed;
}

interface Extracted {
  text: string | null;
  /** URL after redirects and `<link rel="canonical">`. */
  finalUrl: string;
}

/** Read a response body up to `maxBytes`. Stop early to protect memory. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return out + decoder.decode();
}

/** Extract the main text of an HTML page with Readability. */
export function extractMainText(
  html: string,
  pageUrl: string,
  maxChars: number,
): { text: string | null; canonicalLink: string | null } {
  // linkedom, not jsdom: jsdom keeps about 1 MB per parsed document after GC.
  // That breaks the memory budget on a 200-item batch.
  const { document } = parseHTML(html);
  const href = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  let canonicalLink: string | null = null;
  if (href) {
    try {
      canonicalLink = new URL(href, pageUrl).toString();
    } catch {
      canonicalLink = null;
    }
  }
  // Readability needs the base URI to resolve links. The text does not need it.
  const article = new Readability(
    document as unknown as ConstructorParameters<typeof Readability>[0],
  ).parse();
  const text = article?.textContent ? cleanText(article.textContent, maxChars) : "";
  return { text: text || null, canonicalLink };
}

export class Normalizer {
  private readonly maxTextChars: number;
  private readonly snippetMaxChars: number;
  private readonly batchSize: number;
  private readonly maxPageBytes: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly robots: RobotsCache;

  constructor(private readonly options: NormalizeOptions) {
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    this.snippetMaxChars = options.snippetMaxChars ?? DEFAULT_SNIPPET_MAX_CHARS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.doFetch = options.fetchImpl ?? fetch;
    this.robots = new RobotsCache({
      userAgent: options.userAgent,
      fetchImpl: this.doFetch,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Normalize items in small batches. The result keeps the input order. */
  async normalizeAll(raw: RawItem[]): Promise<NormalizedItem[]> {
    const out: NormalizedItem[] = [];
    for (let i = 0; i < raw.length; i += this.batchSize) {
      const batch = raw.slice(i, i + this.batchSize);
      out.push(...(await Promise.all(batch.map((item) => this.normalizeOne(item)))));
    }
    return out;
  }

  async normalizeOne(item: RawItem): Promise<NormalizedItem> {
    let text = item.text ? cleanText(item.text, this.maxTextChars) : "";
    let url = item.url;
    if (text.length < this.snippetMaxChars) {
      const extracted = await this.fetchPage(item.url);
      if (extracted) {
        url = extracted.finalUrl;
        // Keep the feed text when the page gives less.
        if (extracted.text && extracted.text.length > text.length) text = extracted.text;
      }
    }
    const language = detectLanguage(text || item.title, item.language);
    return {
      url: item.url,
      canonicalUrl: canonicalizeUrl(url),
      title: item.title.trim(),
      text: text || null,
      language,
      contentHash: contentHash(item.title, text || null),
      publishedAt: item.publishedAt,
      metadata: item.metadata ?? null,
    };
  }

  /** Fetch a page once, follow redirects and extract the text. Return null on any failure. */
  private async fetchPage(url: string): Promise<Extracted | null> {
    try {
      if (!/^https?:/i.test(url)) return null;
      if (!(await this.robots.isAllowed(url))) return null;
      const response = await this.doFetch(url, {
        headers: {
          "User-Agent": this.options.userAgent,
          Accept: "text/html, application/xhtml+xml;q=0.9",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const redirectedTo = response.url || url;
      const type = response.headers.get("content-type") ?? "";
      if (type && !/html|xml/i.test(type)) {
        await response.body?.cancel();
        return { text: null, finalUrl: redirectedTo };
      }
      const html = await readCapped(response, this.maxPageBytes);
      const { text, canonicalLink } = extractMainText(html, redirectedTo, this.maxTextChars);
      return { text, finalUrl: canonicalLink ?? redirectedTo };
    } catch {
      return null;
    }
  }
}
