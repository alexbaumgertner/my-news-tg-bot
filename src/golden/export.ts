import { stringify } from "csv-stringify/sync";
import type { NormalizedItem } from "../pipeline/normalize.js";
import type { RawItem } from "../fetchers/types.js";
import { CSV_COLUMNS, groupTitles, itemId } from "./shared.js";

const BOM = "﻿";
export const SNIPPET_CHARS = 300;
/** Newest items of one source that enter the sampling pool. */
export const POOL_PER_SOURCE = 50;
/** Maximum items of one dup group in the CSV. */
export const MAX_GROUP_ITEMS = 4;
/** Maximum extra dup groups added although the per-source sample did not hit them. */
export const MAX_EXTRA_GROUPS = 15;

/** A raw item with the source slug and the source language. */
export interface PoolItem {
  source: string;
  raw: RawItem;
}

/** A small seeded random generator (mulberry32). The same seed gives the same shuffle. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle. Return a new array. */
export function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Pick the candidates. Take `perSource` random items from each source.
 * Then add the other items of every dup group that a picked item belongs to.
 * Then add a few more dup groups that span several sources, so duplicates are in the set.
 * An item is never dropped because it looks irrelevant.
 */
export function sampleCandidates(
  pool: PoolItem[],
  options: { perSource: number; seed: number },
): PoolItem[] {
  const random = seededRandom(options.seed);
  const groups = groupTitles(pool.map((entry) => entry.raw.title));
  const bySource = new Map<string, number[]>();
  pool.forEach((entry, index) => {
    const list = bySource.get(entry.source) ?? [];
    list.push(index);
    bySource.set(entry.source, list);
  });

  const picked = new Set<number>();
  for (const slug of [...bySource.keys()].sort()) {
    const indexes = shuffle(bySource.get(slug) ?? [], random);
    for (const index of indexes.slice(0, options.perSource)) picked.add(index);
  }

  const members = new Map<number, number[]>();
  groups.forEach((group, index) => {
    if (group === null) return;
    const list = members.get(group) ?? [];
    list.push(index);
    members.set(group, list);
  });
  const addGroup = (group: number): void => {
    const all = members.get(group) ?? [];
    // Keep the already picked members first. Then fill up with the other members.
    const ordered = [...all.filter((i) => picked.has(i)), ...all.filter((i) => !picked.has(i))];
    for (const index of ordered.slice(0, MAX_GROUP_ITEMS)) picked.add(index);
  };
  for (const index of [...picked]) {
    const group = groups[index];
    if (group !== null && group !== undefined) addGroup(group);
  }
  const extra = shuffle(
    [...members.entries()]
      .filter(([, list]) => {
        if (list.some((i) => picked.has(i))) return false;
        return new Set(list.map((i) => pool[i]?.source)).size > 1;
      })
      .map(([group]) => group),
    random,
  );
  for (const group of extra.slice(0, MAX_EXTRA_GROUPS)) addGroup(group);

  return shuffle(
    [...picked].sort((a, b) => a - b),
    random,
  ).map((i) => pool[i] as PoolItem);
}

export interface CandidateRow {
  source: string;
  item: NormalizedItem;
}

function snippetOf(text: string | null): string {
  if (!text) return "";
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, SNIPPET_CHARS).join("");
}

/** Build the CSV text: UTF-8 with a BOM, so Excel and Numbers read Russian text correctly. */
export function formatCandidatesCsv(rows: CandidateRow[]): string {
  // Drop repeated URLs: the build step needs unique ids.
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const id = itemId(row.item.canonicalUrl);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const groups = groupTitles(unique.map((row) => row.item.title));
  // Put the members of one dup group next to each other, at the place of the first member.
  const firstIndex = new Map<number, number>();
  groups.forEach((group, index) => {
    if (group !== null && !firstIndex.has(group)) firstIndex.set(group, index);
  });
  const order = unique
    .map((row, index) => {
      const group = groups[index] ?? null;
      return { row, group, index, key: group === null ? index : (firstIndex.get(group) ?? index) };
    })
    .sort((a, b) => a.key - b.key || a.index - b.index);

  const records = order.map(({ row, group }) => ({
    id: itemId(row.item.canonicalUrl),
    source: row.source,
    lang: row.item.language,
    title: row.item.title,
    url: row.item.canonicalUrl,
    published_at: row.item.publishedAt ? row.item.publishedAt.toISOString() : "",
    snippet: snippetOf(row.item.text),
    dup_group: group === null ? "" : String(group),
    label: "",
    topics: "",
    reason: "",
  }));
  return BOM + stringify(records, { header: true, columns: [...CSV_COLUMNS] });
}
