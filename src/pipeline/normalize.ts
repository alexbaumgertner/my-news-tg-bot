import { Readability } from "@mozilla/readability";
import { franc } from "franc-min";
import { parseHTML } from "linkedom";
import { canonicalizeUrl, contentHash } from "../fetchers/normalize.js";
import type { RawItem } from "../fetchers/types.js";
import { RobotsCache, readCappedText } from "./robots.js";

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
const MAX_REDIRECTS = 5;
const MAX_HTML_INPUT_CHARS = 200_000;

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

/** Collapse white space and cap the length. Do not touch markup characters. */
export function normalizeWhitespace(input: string, maxChars: number): string {
  // Each regex is linear. A pattern like /\s*\n\s*/ is quadratic on long white-space runs.
  const collapsed = input
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars).trimEnd() : collapsed;
}

/**
 * Convert HTML feed text to plain text. Use it for feed text, which often contains HTML.
 * linkedom decodes all named and numeric entities and drops tags, with or without tags.
 * Script and style content is removed. Feed excerpts are small, so we parse each one
 * on its own. The document is not kept after the call.
 */
export function cleanText(input: string, maxChars: number): string {
  // A feed excerpt is small. Cut a huge input before the parser to bound time and memory.
  const bounded =
    input.length > MAX_HTML_INPUT_CHARS ? input.slice(0, MAX_HTML_INPUT_CHARS) : input;
  if (!/[<&]/.test(bounded)) return normalizeWhitespace(bounded, maxChars);
  // Put a space around each tag so that adjacent blocks do not join into one word.
  // [^<>]* stops at the next "<", so the scan stays linear.
  const spaced = bounded.replace(/<\/?[a-z!][^<>]*>/gi, " $& ");
  const { document } = parseHTML(`<!doctype html><html><body>${spaced}</body></html>`);
  for (const node of Array.from(
    document.querySelectorAll("script, style") as Iterable<{ remove(): void }>,
  )) {
    node.remove();
  }
  const text = document.body?.textContent ?? "";
  return normalizeWhitespace(text, maxChars);
}

interface Extracted {
  text: string | null;
  /** URL after redirects and `<link rel="canonical">`. */
  finalUrl: string;
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
  // textContent is plain text already. Do not strip markup again.
  const text = article?.textContent ? normalizeWhitespace(article.textContent, maxChars) : "";
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
    const clean = item.textFormat === "text" ? normalizeWhitespace : cleanText;
    let text = item.text ? clean(item.text, this.maxTextChars) : "";
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
      // Follow redirects by hand. Check robots.txt for every destination before the request.
      const signal = AbortSignal.timeout(this.timeoutMs);
      let current = url;
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!/^https?:/i.test(current)) return null;
        if (!(await this.robots.isAllowed(current))) return null;
        const res = await this.doFetch(current, {
          headers: {
            "User-Agent": this.options.userAgent,
            Accept: "text/html, application/xhtml+xml;q=0.9",
          },
          signal,
          redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel();
          const location = res.headers.get("location");
          if (!location) return null;
          current = new URL(location, current).toString();
          continue;
        }
        response = res;
        break;
      }
      if (!response) return null;
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const redirectedTo = current;
      const type = response.headers.get("content-type") ?? "";
      if (type && !/html|xml/i.test(type)) {
        await response.body?.cancel();
        return { text: null, finalUrl: redirectedTo };
      }
      const html = await readCappedText(response, this.maxPageBytes);
      const { text, canonicalLink } = extractMainText(html, redirectedTo, this.maxTextChars);
      return { text, finalUrl: canonicalLink ?? redirectedTo };
    } catch {
      return null;
    }
  }
}
