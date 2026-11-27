/** What clustering needs to know about an item. */
export interface ClusterItem {
  id: number;
  title: string;
  embedding: number[];
  /** Trust of the source, 1-5. */
  trust: number;
  /** Publication time, or the fetch time when the item has no date. */
  at: Date;
  /** Length of the text. Used as the last tie-breaker. */
  textLength: number;
}

/** The current best item of a story. */
export type Representative = Pick<ClusterItem, "id" | "trust" | "at" | "textLength">;

export interface NearestStory {
  storyId: number;
  similarity: number;
  representative: Representative;
}

/** Storage used by `assignToStory`. The database and the tests each have one. */
export interface StoryStore {
  /**
   * Return the story with the highest cosine similarity to `embedding`.
   * Only stories whose `lastItemAt` is within `windowMs` of `at` count. Return null if none.
   */
  findNearest(embedding: number[], at: Date, windowMs: number): Promise<NearestStory | null>;
  /** Create a story with `item` as its representative. Return the story id. */
  createStory(item: ClusterItem): Promise<number>;
  /** Put `item` into a story. Move `lastItemAt` forward when `item.at` is newer. */
  attach(storyId: number, item: ClusterItem): Promise<void>;
  /** Make `item` the representative: copy its title and embedding to the story. */
  setRepresentative(storyId: number, item: ClusterItem): Promise<void>;
}

export interface ClusterOptions {
  /** Minimum cosine similarity to join a story. */
  threshold: number;
  /** Maximum time between an item and the newest item of a story. */
  windowMs: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vectors have different sizes");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Compare two items as the representative of a story. Return a negative number
 * when `a` is better. Order: higher source trust, earlier publication, longer text, lower id.
 * Trust stands for "primary source first": the source list gives primary sources a high trust.
 */
export function compareRepresentatives(a: Representative, b: Representative): number {
  return (
    b.trust - a.trust ||
    a.at.getTime() - b.at.getTime() ||
    b.textLength - a.textLength ||
    a.id - b.id
  );
}

/** Put one item into the nearest story, or into a new story. */
export async function assignToStory(
  store: StoryStore,
  item: ClusterItem,
  options: ClusterOptions,
): Promise<{ storyId: number; created: boolean }> {
  const nearest = await store.findNearest(item.embedding, item.at, options.windowMs);
  if (!nearest || nearest.similarity < options.threshold) {
    return { storyId: await store.createStory(item), created: true };
  }
  await store.attach(nearest.storyId, item);
  if (compareRepresentatives(item, nearest.representative) < 0) {
    await store.setRepresentative(nearest.storyId, item);
  }
  return { storyId: nearest.storyId, created: false };
}
