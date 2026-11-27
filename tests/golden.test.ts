import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { Source } from "../src/config.js";
import type { Fetcher, RawItem } from "../src/fetchers/types.js";
import { GoldenBuildError, buildGolden } from "../src/golden/build.js";
import { collectCandidates } from "../src/golden/collect.js";
import {
  formatCandidatesCsv,
  sampleCandidates,
  seededRandom,
  type CandidateRow,
  type PoolItem,
} from "../src/golden/export.js";
import { CSV_COLUMNS, groupTitles, itemId } from "../src/golden/shared.js";

function row(
  source: string,
  title: string,
  url: string,
  text: string | null = "Body",
): CandidateRow {
  return {
    source,
    item: {
      url,
      canonicalUrl: url,
      title,
      text,
      language: /[а-я]/i.test(title) ? "ru" : "en",
      contentHash: "h",
      publishedAt: new Date("2026-11-02T10:00:00Z"),
      metadata: null,
    },
  };
}

function parseCsv(text: string): Record<string, string>[] {
  return parse(text, { bom: true, columns: true });
}

describe("itemId", () => {
  it("is stable and depends on the URL only", () => {
    expect(itemId("https://example.com/a")).toBe(itemId("https://example.com/a"));
    expect(itemId("https://example.com/a")).not.toBe(itemId("https://example.com/b"));
    expect(itemId("https://example.com/a")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("groupTitles", () => {
  it("groups almost equal titles and leaves others empty", () => {
    const groups = groupTitles([
      "Scientists find water on the Moon",
      "Unrelated story about football",
      "Scientists find water on the moon!",
      "Ученые нашли воду на Луне сегодня",
      "Ученые нашли воду на Луне сегодня.",
    ]);
    expect(groups).toEqual([1, null, 1, 2, 2]);
  });

  it("matches short titles only when they are equal", () => {
    expect(groupTitles(["Big news", "Big news here"])).toEqual([null, null]);
    expect(groupTitles(["Big news", "big NEWS"])).toEqual([1, 1]);
  });
});

describe("formatCandidatesCsv", () => {
  const rows = [
    row("a", "Solo story", "https://a.example/1", "x".repeat(400)),
    row("a", "Scientists find water on the Moon", "https://a.example/2"),
    row("b", "Ученые нашли воду на Луне", "https://b.example/3", 'Привет,\n"мир"'),
    row("b", "Scientists find water on the moon", "https://b.example/4"),
    row("b", "Duplicate URL", "https://a.example/1"),
  ];
  const csv = formatCandidatesCsv(rows);

  it("starts with a UTF-8 BOM and the fixed header", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\n", 1)[0]).toBe(CSV_COLUMNS.join(","));
  });

  it("round-trips Russian text, quotes and new lines", () => {
    const records = parseCsv(csv);
    const russian = records.find((r) => r.source === "b" && r.lang === "ru");
    expect(russian?.title).toBe("Ученые нашли воду на Луне");
    expect(russian?.snippet).toBe('Привет, "мир"');
  });

  it("cuts the snippet at 300 characters and leaves the owner columns empty", () => {
    const first = parseCsv(csv).find((r) => r.url === "https://a.example/1");
    expect(first?.snippet).toHaveLength(300);
    expect([first?.label, first?.topics, first?.reason]).toEqual(["", "", ""]);
  });

  it("drops a repeated URL and sets the id from the URL", () => {
    const records = parseCsv(csv);
    expect(records).toHaveLength(4);
    expect(records[0]?.id).toBe(itemId(records[0]?.url ?? ""));
  });

  it("sets dup_group and puts the members next to each other", () => {
    const records = parseCsv(csv);
    const groups = records.map((r) => r.dup_group);
    expect(groups.filter((g) => g === "1")).toHaveLength(2);
    const at = groups.indexOf("1");
    expect(groups[at + 1]).toBe("1");
    expect(groups.filter((g) => g === "")).toHaveLength(2);
  });
});

describe("sampleCandidates", () => {
  const pool: PoolItem[] = [];
  const add = (source: string, title: string, n: number) =>
    pool.push({
      source,
      raw: {
        url: `https://${source}.example/${n}`,
        title,
        text: null,
        publishedAt: null,
        language: "en",
      } as RawItem,
    });
  for (let i = 0; i < 10; i++) add("a", `Alpha story number ${i} unique words ${i * 7}`, i);
  for (let i = 0; i < 10; i++) add("b", `Beta item ${i} different content ${i * 13}`, i);
  add("a", "Earthquake hits the coast of Japan this morning", 100);
  add("b", "Earthquake hits the coast of Japan this morning", 101);
  add("c", "Earthquake hits the coast of Japan this morning", 102);

  it("is repeatable for one seed", () => {
    const one = sampleCandidates(pool, { perSource: 2, seed: 5 }).map((p) => p.raw.url);
    const two = sampleCandidates(pool, { perSource: 2, seed: 5 }).map((p) => p.raw.url);
    expect(one).toEqual(two);
  });

  it("takes items from every source and adds the duplicates of a picked story", () => {
    const picked = sampleCandidates(pool, { perSource: 1, seed: 1 });
    expect(new Set(picked.map((p) => p.source))).toEqual(new Set(["a", "b", "c"]));
    const quake = picked.filter((p) => p.raw.title.startsWith("Earthquake"));
    // Source c has only the duplicate, so its pick pulls in the other two.
    expect(quake).toHaveLength(3);
  });

  it("makes the same numbers for one seed", () => {
    const random = seededRandom(3);
    const again = seededRandom(3);
    expect([random(), random()]).toEqual([again(), again()]);
  });
});

describe("collectCandidates", () => {
  const source = (id: string, active = true): Source => ({
    id,
    name: id,
    type: "rss",
    url: `https://${id}.example/feed`,
    language: "en",
    topics: [],
    trust: 3,
    poll_interval: "1h",
    active,
  });

  it("continues when a source fails and skips inactive sources", async () => {
    const fetcher: Fetcher = {
      async fetch(src) {
        if (src.slug === "bad") throw new Error("boom");
        return {
          items: [
            {
              url: `https://${src.slug}.example/1`,
              title: "T",
              text: "x",
              publishedAt: null,
              language: "en",
            },
          ],
          notModified: false,
          etag: null,
          lastModified: null,
        };
      },
    };
    const rows = await collectCandidates({
      sources: [source("bad"), source("good"), source("off", false)],
      perSource: 3,
      seed: 1,
      userAgent: "test",
      hnMinScore: 100,
      logger: pino({ level: "silent" }),
      fetchers: { rss: fetcher },
      normalizer: {
        normalizeAll: async (items) =>
          items.map((item) => ({
            url: item.url,
            canonicalUrl: item.url,
            title: item.title,
            text: item.text,
            language: item.language,
            contentHash: "h",
            publishedAt: null,
            metadata: null,
          })),
      },
    });
    expect(rows.map((r) => r.source)).toEqual(["good"]);
  });
});

describe("buildGolden", () => {
  const file = (name: string) => readFileSync(`tests/fixtures/golden/${name}`, "utf8");

  it("skips unlabeled rows, sorts by id and counts the labels", () => {
    const result = buildGolden(file("labeled.csv"));
    const lines = result.jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p.id)).toEqual(["aaaa000000000001", "bbbb000000000002"]);
    expect(parsed[0]).toMatchObject({
      label: "keep",
      topics: ["science_space", "medicine_hht"],
      dup_group: 1,
      title: "Первая новость",
    });
    expect(parsed[1]).toMatchObject({ label: "drop", topics: [], dup_group: null });
    expect([result.keep, result.drop]).toEqual([1, 1]);
  });

  it("warns when there are fewer than 25 of a label", () => {
    expect(buildGolden(file("labeled.csv")).warnings).toHaveLength(2);
  });

  it("reads a semicolon file with a BOM and CRLF", () => {
    const result = buildGolden("﻿" + file("labeled-semicolon.csv"));
    expect(result.items[0]).toMatchObject({ id: "x1", title: "A, b", topics: ["sport"] });
  });

  describe.each([
    ["comma", ","],
    ["semicolon", ";"],
    ["tab", "\t"],
  ])("quoted headers with a %s", (_name, d) => {
    const columns = [...CSV_COLUMNS];
    const header = columns.map((c) => `"${c}"`).join(d);
    const values = columns.map((c) => {
      const byColumn: Record<string, string> = {
        id: "q1",
        title: "A, b",
        label: "keep",
        topics: "sport",
        reason: "ok",
      };
      return `"${byColumn[c] ?? ""}"`;
    });
    const body = `${header}\r\n${values.join(d)}\r\n`;

    it("detects the delimiter", () => {
      const result = buildGolden(body);
      expect(result.items[0]).toMatchObject({ id: "q1", title: "A, b", topics: ["sport"] });
    });

    it("detects the delimiter with a BOM", () => {
      const result = buildGolden("﻿" + body);
      expect(result.items[0]).toMatchObject({ id: "q1", label: "keep" });
    });
  });

  it("accepts a label in any case", () => {
    const csv = file("labeled.csv").replace(",keep,", ",Keep ,");
    expect(buildGolden(csv).keep).toBe(1);
  });

  const header = "id,source,lang,title,url,published_at,snippet,dup_group,label,topics,reason\n";

  it("fails with the row number on a wrong label", () => {
    const csv = header + "a,s,en,T,u,,,,maybe,x,why\n" + "b,s,en,T,u,,,,keep,x,why\n";
    expect(() => buildGolden(csv)).toThrow(/Row 2: label must be keep or drop/);
  });

  it("fails on an empty reason, a bad topic and a keep without topics", () => {
    const csv =
      header +
      "a,s,en,T,u,,,,keep,x,\n" +
      "b,s,en,T,u,,,,drop,Bad Topic,why\n" +
      "c,s,en,T,u,,,,keep,,why\n";
    let message = "";
    try {
      buildGolden(csv);
    } catch (error) {
      expect(error).toBeInstanceOf(GoldenBuildError);
      message = (error as Error).message;
    }
    expect(message).toContain("Row 2: reason is empty");
    expect(message).toContain('Row 3: topic "Bad Topic" is not a snake_case id');
    expect(message).toContain("Row 4: keep needs at least one topic");
  });

  it("fails on a repeated id and on a file without labels", () => {
    const dup = header + "a,s,en,T,u,,,,drop,,why\n" + "a,s,en,T,u,,,,drop,,why\n";
    expect(() => buildGolden(dup)).toThrow(/Row 3: id a is already used in row 2/);
    expect(() => buildGolden(header + "a,s,en,T,u,,,,,,\n")).toThrow(/No labeled rows/);
  });

  it("fails when a required column is missing", () => {
    expect(() => buildGolden("id,label\na,keep\n")).toThrow(/Missing CSV columns: topics, reason/);
  });

  it("builds from an export: the export CSV is a valid input", () => {
    const csv = formatCandidatesCsv([row("a", "One", "https://a.example/1")]);
    expect(() => buildGolden(csv)).toThrow(/No labeled rows/);
  });
});
