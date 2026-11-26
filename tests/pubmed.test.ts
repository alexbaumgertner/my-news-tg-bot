import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PubmedFetcher,
  efetchUrl,
  esearchUrl,
  parsePubmedXml,
  studyTypeOf,
} from "../src/fetchers/pubmed.js";
import type { FetchSource } from "../src/fetchers/types.js";

const esearchJson = readFileSync("tests/fixtures/pubmed/esearch.json", "utf8");
const efetchXml = readFileSync("tests/fixtures/pubmed/efetch.xml", "utf8");

const source: FetchSource = {
  slug: "pubmed-hht",
  type: "pubmed",
  url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=hereditary+hemorrhagic+telangiectasia&retmax=20&retmode=json&sort=date",
  language: "en",
  etag: null,
  lastModified: null,
};

function makeFetcher(bodies: string[], apiKey?: string, start = 1_000) {
  let clock = start;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const fetchImpl = vi.fn(async () => new Response(bodies.shift() ?? "", { status: 200 }));
  const fetcher = new PubmedFetcher({
    http: {
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
    },
    apiKey,
    now: () => clock,
  });
  const urls = () => fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
  return { fetcher, sleep, urls };
}

describe("parsePubmedXml", () => {
  const items = parsePubmedXml(efetchXml, "en");

  it("maps title, abstract, journal, link and publication types", () => {
    expect(items).toHaveLength(4);
    const first = items[0]!;
    expect(first.url).toBe("https://pubmed.ncbi.nlm.nih.gov/43091933/");
    // Inline <i> tags keep their text and the final dot is removed.
    expect(first.title).toBe(
      "Co-Occurrence of an Activating AVPR2 Variant and a Pathogenic ACVRL1 Variant in an Infant",
    );
    expect(first.text).toContain("with both AVPR2 and ACVRL1 variants.");
    expect(first.language).toBe("en");
    expect(first.metadata).toEqual({
      pmid: "43091933",
      journal: "International journal of molecular sciences",
      publicationTypes: ["Case Reports", "Journal Article"],
      studyType: "case-report",
      doi: "10.3390/ijms26000001",
    });
    expect(first.publishedAt?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });

  it("decodes XML entities and keeps the labels of a structured abstract", () => {
    const second = items[1]!;
    expect(second.metadata?.journal).toBe("Molecular genetics & genomic medicine");
    expect(second.text).toBe(
      "BACKGROUND: HHT causes bleeding.\n\nRESULTS: Bevacizumab reduced epistaxis in most patients.",
    );
    expect(second.metadata?.studyType).toBe("meta-analysis");
    // PubDate with year and month only: first day of the month.
    expect(second.publishedAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("prefers the electronic date and handles a missing abstract and DOI", () => {
    expect(items[2]!.publishedAt?.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(items[2]!.metadata?.studyType).toBe("clinical-trial");
    expect(items[2]!.metadata?.doi).toBeNull();
    expect(items[3]!.text).toBeNull();
    expect(items[3]!.publishedAt).toBeNull();
    expect(items[3]!.metadata?.studyType).toBeNull();
  });

  it("rejects an unexpected root", () => {
    expect(() => parsePubmedXml("<html><body>Busy</body></html>", "en")).toThrow(/<html>/);
    expect(() => parsePubmedXml("", "en")).toThrow(/Unexpected/);
  });

  it("returns no items for an empty set", () => {
    expect(parsePubmedXml("<PubmedArticleSet></PubmedArticleSet>", "en")).toEqual([]);
  });
});

describe("studyTypeOf", () => {
  it("picks the strongest evidence first", () => {
    expect(studyTypeOf(["Review", "Systematic Review", "Meta-Analysis"])).toBe("meta-analysis");
    expect(studyTypeOf(["Journal Article", "Randomized Controlled Trial"])).toBe(
      "randomized-controlled-trial",
    );
    expect(studyTypeOf(["Review"])).toBe("review");
    expect(studyTypeOf(["Journal Article"])).toBeNull();
  });
});

describe("URL builders", () => {
  it("adds the API key and the date range", () => {
    const url = new URL(esearchUrl(source.url, new Date("2026-11-20T10:00:00Z"), "KEY"));
    expect(url.searchParams.get("term")).toBe("hereditary hemorrhagic telangiectasia");
    expect(url.searchParams.get("api_key")).toBe("KEY");
    expect(url.searchParams.get("datetype")).toBe("edat");
    expect(url.searchParams.get("mindate")).toBe("2026/11/20");
    expect(url.searchParams.get("maxdate")).toBe("3000");
  });

  it("sends no API key and no date range when they are not set", () => {
    const url = new URL(esearchUrl(source.url, null));
    expect(url.searchParams.has("api_key")).toBe(false);
    expect(url.searchParams.has("mindate")).toBe(false);
    expect(new URL(efetchUrl(["1", "2"])).searchParams.get("id")).toBe("1,2");
  });

  it("rejects a URL that is not esearch", () => {
    expect(() => esearchUrl("https://example.com/feed", null)).toThrow(/esearch/);
  });
});

describe("PubmedFetcher", () => {
  it("runs esearch, then efetch for the found ids", async () => {
    const { fetcher, urls } = makeFetcher([esearchJson, efetchXml]);
    const result = await fetcher.fetch(source, null);
    expect(result.items).toHaveLength(4);
    expect(urls()).toHaveLength(2);
    expect(urls()[0]).toContain("esearch.fcgi");
    expect(new URL(urls()[1]!).searchParams.get("id")).toBe("43091933,43080066,43074935,43070001");
  });

  it("skips efetch when the search finds nothing", async () => {
    const empty = JSON.stringify({ esearchresult: { count: "0", idlist: [] } });
    const { fetcher, urls } = makeFetcher([empty]);
    const result = await fetcher.fetch(source, null);
    expect(result.items).toEqual([]);
    expect(urls()).toHaveLength(1);
  });

  it("limits the rate: 3 requests per second without a key, 10 with a key", async () => {
    const without = makeFetcher([esearchJson, efetchXml]);
    await without.fetcher.fetch(source, null);
    expect(without.sleep).toHaveBeenCalledWith(350);

    const withKey = makeFetcher([esearchJson, efetchXml], "KEY");
    await withKey.fetcher.fetch(source, null);
    expect(withKey.sleep).toHaveBeenCalledWith(110);
    expect(withKey.urls().every((u) => u.includes("api_key=KEY"))).toBe(true);
  });

  it("reads every page of the search with retstart", async () => {
    const page = (ids: string[]) => JSON.stringify({ esearchresult: { count: "3", idlist: ids } });
    const { fetcher, urls, sleep } = makeFetcher([
      page(["43091933", "43080066"]),
      efetchXml,
      page(["43074935"]),
      efetchXml,
    ]);
    const result = await fetcher.fetch(source, null);
    const u = urls();
    expect(u).toHaveLength(4);
    expect(new URL(u[0]!).searchParams.has("retstart")).toBe(false);
    expect(new URL(u[2]!).searchParams.get("retstart")).toBe("2");
    // The same articles in both efetch answers are stored once.
    expect(result.items).toHaveLength(4);
    // The rate limit also applies between pages.
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("fails when the search needs more pages than the limit", async () => {
    const endless = Array.from({ length: 60 }, () => [
      JSON.stringify({ esearchresult: { count: "100000", idlist: ["1"] } }),
      efetchXml,
    ]).flat();
    const { fetcher } = makeFetcher(endless);
    await expect(fetcher.fetch(source, null)).rejects.toThrow(/pages/);
  });

  it("fails on an efetch error document", async () => {
    const error =
      '<?xml version="1.0"?><eFetchResult><ERROR>Invalid db name</ERROR></eFetchResult>';
    const { fetcher } = makeFetcher([esearchJson, error]);
    await expect(fetcher.fetch(source, null)).rejects.toThrow(/PubmedArticleSet/);
  });

  it("bounds the first run to the default lookback window", async () => {
    const start = Date.UTC(2026, 10, 26);
    const { fetcher, urls } = makeFetcher([esearchJson, efetchXml], undefined, start);
    // The real archive count is 4997. The windowed count is small, so the run completes.
    const result = await fetcher.fetch(source, null);
    expect(result.items).toHaveLength(4);
    const params = new URL(urls()[0]!).searchParams;
    expect(params.get("datetype")).toBe("edat");
    expect(params.get("mindate")).toBe("2026/08/28");
    expect(params.get("maxdate")).toBe("3000");
  });

  it("uses initialLookbackDays of the source on the first run", async () => {
    const start = Date.UTC(2026, 10, 26);
    const { fetcher, urls } = makeFetcher([esearchJson, efetchXml], undefined, start);
    await fetcher.fetch({ ...source, initialLookbackDays: 7 }, null);
    expect(new URL(urls()[0]!).searchParams.get("mindate")).toBe("2026/11/19");
  });

  it("keeps the given since date on incremental runs", async () => {
    const { fetcher, urls } = makeFetcher(
      [esearchJson, efetchXml],
      undefined,
      Date.UTC(2026, 10, 26),
    );
    await fetcher.fetch({ ...source, initialLookbackDays: 7 }, new Date(Date.UTC(2026, 10, 1)));
    expect(new URL(urls()[0]!).searchParams.get("mindate")).toBe("2026/11/01");
  });

  it("fails on an invalid esearch answer", async () => {
    const { fetcher } = makeFetcher(['{"unexpected":true}']);
    await expect(fetcher.fetch(source, null)).rejects.toThrow();
  });
});
