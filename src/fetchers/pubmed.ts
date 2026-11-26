import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { httpGet, type HttpOptions } from "./http.js";
import type { FetchResult, FetchSource, Fetcher, RawItem } from "./types.js";

const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
/** NCBI allows 3 requests per second without an API key and 10 with a key. */
const GAP_WITHOUT_KEY_MS = 350;
const GAP_WITH_KEY_MS = 110;
const TOOL_NAME = "my-news-tg-bot";
export const PUBMED_ARTICLE_URL = "https://pubmed.ncbi.nlm.nih.gov/";

const esearchSchema = z.object({
  esearchresult: z.object({
    count: z.coerce.number().int().nonnegative(),
    idlist: z.array(z.string()),
  }),
});

/** First-run window when the source sets no `initial_lookback_days`. */
export const DEFAULT_INITIAL_LOOKBACK_DAYS = 90;
const DAY_MS = 86_400_000;

/** Safety limit. A search that needs more pages fails instead of losing records. */
const MAX_PAGES = 50;

/**
 * Publication types, from the strongest evidence to the weakest.
 * The first match is the study type of the article.
 */
const STUDY_TYPES: [publicationType: string, studyType: string][] = [
  ["Meta-Analysis", "meta-analysis"],
  ["Systematic Review", "systematic-review"],
  ["Randomized Controlled Trial", "randomized-controlled-trial"],
  ["Clinical Trial", "clinical-trial"],
  ["Guideline", "guideline"],
  ["Practice Guideline", "guideline"],
  ["Observational Study", "observational-study"],
  ["Case Reports", "case-report"],
  ["Review", "review"],
  ["Preprint", "preprint"],
];

/** Map PubMed publication types to one study type. Returns null when no type matches. */
export function studyTypeOf(publicationTypes: string[]): string | null {
  const lower = new Set(publicationTypes.map((t) => t.toLowerCase()));
  for (const [publicationType, studyType] of STUDY_TYPES) {
    if (lower.has(publicationType.toLowerCase())) return studyType;
  }
  // "Clinical Trial, Phase II" and similar types.
  if (publicationTypes.some((t) => /^clinical trial/i.test(t))) return "clinical-trial";
  return null;
}

export interface PubmedOptions {
  http: HttpOptions;
  /** NCBI API key. It raises the rate limit from 3 to 10 requests per second. */
  apiKey?: string;
  /** Override the minimum time between two requests. */
  minRequestGapMs?: number;
  now?: () => number;
}

// With preserveOrder the parser returns nodes as `{ tag: [children], ":@": attributes }`.
type XmlNode = Record<string, unknown>;

const TEXT = "#text";

/** Find the first node with this tag among the siblings in `list`. */
function find(list: XmlNode[], tag: string): XmlNode[] | undefined {
  const node = list.find((n) => tag in n);
  const value = node?.[tag];
  return Array.isArray(value) ? (value as XmlNode[]) : undefined;
}

function findAll(list: XmlNode[], tag: string): XmlNode[][] {
  return list.flatMap((n) => (Array.isArray(n[tag]) ? [n[tag] as XmlNode[]] : []));
}

/** All text below the nodes, in document order. Inline tags such as <i> keep their text. */
function textOf(nodes: XmlNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (TEXT in n) return String(n[TEXT]);
      return Object.entries(n)
        .filter(([key]) => key !== ":@")
        .map(([, value]) => (Array.isArray(value) ? textOf(value as XmlNode[]) : ""))
        .join("");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(node: XmlNode, name: string): string | undefined {
  const attrs = node[":@"] as Record<string, string> | undefined;
  return attrs?.[`@_${name}`];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseMonth(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const month = Number(raw);
    return month >= 1 && month <= 12 ? month : null;
  }
  const index = MONTHS.indexOf(raw.slice(0, 3).toLowerCase());
  return index >= 0 ? index + 1 : null;
}

/** Read <Year>, <Month>, <Day>. A missing month or day becomes 1. */
function parseDate(nodes: XmlNode[] | undefined): Date | null {
  if (!nodes) return null;
  const year = Number(textOf(find(nodes, "Year")));
  if (!Number.isInteger(year) || year < 1000) return null;
  const month = parseMonth(textOf(find(nodes, "Month"))) ?? 1;
  const day = Number(textOf(find(nodes, "Day"))) || 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Abstract text. A structured abstract keeps its section labels, for example "BACKGROUND: ...". */
function abstractOf(article: XmlNode[]): string | null {
  const parts = (find(article, "Abstract") ?? [])
    .filter((n) => "AbstractText" in n)
    .map((node) => {
      const text = textOf(node["AbstractText"] as XmlNode[]);
      const label = attribute(node, "Label");
      return label && text ? `${label}: ${text}` : text;
    });
  const abstract = parts.filter(Boolean).join("\n\n");
  return abstract || null;
}

/** Parse the efetch XML into items. Articles without a PMID or a title are skipped. */
export function parsePubmedXml(xml: string, language: string): RawItem[] {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    // Keep spaces around inline tags such as <i>.
    trimValues: false,
    processEntities: true,
  });
  const root = parser.parse(xml) as XmlNode[];
  const set = find(root, "PubmedArticleSet");
  if (!set) {
    const rootTag = root.flatMap((n) => Object.keys(n)).find((key) => key !== ":@");
    throw new Error(
      `Unexpected efetch response: root is <${rootTag ?? "none"}>, not <PubmedArticleSet>`,
    );
  }
  const items: RawItem[] = [];

  for (const articleNode of findAll(set, "PubmedArticle")) {
    const citation = find(articleNode, "MedlineCitation");
    const article = find(citation ?? [], "Article");
    if (!citation || !article) continue;
    const pmid = textOf(find(citation, "PMID"));
    const title = textOf(find(article, "ArticleTitle")).replace(/\.$/, "");
    if (!pmid || !title) continue;

    const journalNodes = find(article, "Journal") ?? [];
    const journal = textOf(find(journalNodes, "Title")) || null;
    const pubDate = find(find(journalNodes, "JournalIssue") ?? [], "PubDate");
    // The electronic date is the most exact. Many articles have only year and month in PubDate.
    const publishedAt = parseDate(find(article, "ArticleDate")) ?? parseDate(pubDate);

    const publicationTypes = findAll(find(article, "PublicationTypeList") ?? [], "PublicationType")
      .map((nodes) => textOf(nodes))
      .filter(Boolean);

    const idList = find(find(articleNode, "PubmedData") ?? [], "ArticleIdList") ?? [];
    const doiNode = idList.find((n) => "ArticleId" in n && attribute(n, "IdType") === "doi");
    const doi = doiNode ? textOf(doiNode["ArticleId"] as XmlNode[]) || null : null;

    items.push({
      url: `${PUBMED_ARTICLE_URL}${pmid}/`,
      title,
      text: abstractOf(article),
      textFormat: "text",
      publishedAt,
      language,
      metadata: {
        pmid,
        journal,
        publicationTypes,
        studyType: studyTypeOf(publicationTypes),
        doi,
      },
    });
  }
  return items;
}

/**
 * Build the esearch URL from the configured source URL.
 * Forces JSON, adds the tool name and the API key, and limits the date range with `since`.
 */
export function esearchUrl(
  sourceUrl: string,
  since: Date | null,
  apiKey?: string,
  retstart = 0,
): string {
  const url = new URL(sourceUrl);
  if (!url.pathname.endsWith("/esearch.fcgi")) {
    throw new Error(`Not an E-utilities esearch URL: ${sourceUrl}`);
  }
  url.searchParams.set("retmode", "json");
  url.searchParams.set("tool", TOOL_NAME);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  if (retstart > 0) url.searchParams.set("retstart", String(retstart));
  if (since) {
    // Entrez date: the day the record entered PubMed. mindate needs maxdate.
    const day = since.toISOString().slice(0, 10).replaceAll("-", "/");
    url.searchParams.set("datetype", "edat");
    url.searchParams.set("mindate", day);
    url.searchParams.set("maxdate", "3000");
  }
  return url.toString();
}

export function efetchUrl(ids: string[], apiKey?: string): string {
  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
    tool: TOOL_NAME,
  });
  if (apiKey) params.set("api_key", apiKey);
  return `${EFETCH_URL}?${params.toString()}`;
}

/**
 * Reads PubMed with NCBI E-utilities.
 * `source.url` is an esearch URL that holds the query. The fetcher runs it
 * and then loads the details of the found articles with efetch.
 */
export class PubmedFetcher implements Fetcher {
  private readonly gapMs: number;
  private readonly now: () => number;
  private lastRequestAt: number | null = null;

  constructor(private readonly options: PubmedOptions) {
    this.gapMs = options.minRequestGapMs ?? (options.apiKey ? GAP_WITH_KEY_MS : GAP_WITHOUT_KEY_MS);
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

  private get(url: string) {
    // The throttle runs before every attempt, so retries keep the gap too.
    return httpGet(url, {}, { ...this.options.http, beforeAttempt: () => this.throttle() });
  }

  async fetch(source: FetchSource, since: Date | null): Promise<FetchResult> {
    const { apiKey } = this.options;
    const items = new Map<string, RawItem>();
    // The first run has no `since`. Search a bounded window, not the whole archive.
    const lookbackDays = source.initialLookbackDays ?? DEFAULT_INITIAL_LOOKBACK_DAYS;
    const window = since ?? new Date(this.now() - lookbackDays * DAY_MS);
    let retstart = 0;

    // Read every page of the date window. The caller advances lastSuccessAt only after all pages.
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(`PubMed search has more than ${MAX_PAGES} pages: ${source.slug}`);
      }
      const search = await this.get(esearchUrl(source.url, window, apiKey, retstart));
      const { count, idlist } = esearchSchema.parse(JSON.parse(search.body)).esearchresult;
      if (idlist.length === 0) break;

      const details = await this.get(efetchUrl(idlist, apiKey));
      for (const item of parsePubmedXml(details.body, source.language)) items.set(item.url, item);

      retstart += idlist.length;
      if (retstart >= count) break;
    }
    return { items: [...items.values()], notModified: false, etag: null, lastModified: null };
  }
}
