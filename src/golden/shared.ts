import { createHash } from "node:crypto";

/** Columns of the candidates CSV. The owner fills the last three. */
export const CSV_COLUMNS = [
  "id",
  "source",
  "lang",
  "title",
  "url",
  "published_at",
  "snippet",
  "dup_group",
  "label",
  "topics",
  "reason",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Stable item id: the first 16 hex characters of the SHA-256 of the canonical URL. */
export function itemId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

const MIN_TOKENS_FOR_SIMILARITY = 4;
const SIMILARITY_THRESHOLD = 0.8;

/** Lower-case a title and keep letters and digits only, as a list of words. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Group titles that are almost equal. Return one entry per title:
 * a group number (from 1, in order of first appearance) or null when the title is alone.
 * Two titles match when their normalized text is equal, or when they have at least
 * 4 words and the word sets overlap by 80% or more (Jaccard). Matching is transitive.
 */
export function groupTitles(titles: string[]): (number | null)[] {
  const tokens = titles.map((title) => titleTokens(title));
  const keys = tokens.map((list) => list.join(" "));
  const sets = tokens.map((list) => new Set(list));
  const parent = titles.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[i] !== root) {
      const next = parent[i] as number;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      if (find(i) === find(j)) continue;
      const a = sets[i] as Set<string>;
      const b = sets[j] as Set<string>;
      const same = keys[i] !== "" && keys[i] === keys[j];
      const similar =
        a.size >= MIN_TOKENS_FOR_SIMILARITY &&
        b.size >= MIN_TOKENS_FOR_SIMILARITY &&
        jaccard(a, b) >= SIMILARITY_THRESHOLD;
      if (same || similar) parent[find(j)] = find(i);
    }
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < titles.length; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  const numbers = new Map<number, number>();
  return titles.map((_, i) => {
    const root = find(i);
    if ((sizes.get(root) ?? 0) < 2) return null;
    if (!numbers.has(root)) numbers.set(root, numbers.size + 1);
    return numbers.get(root) as number;
  });
}
