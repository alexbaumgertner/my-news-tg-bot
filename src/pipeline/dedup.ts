import {
  and,
  asc,
  desc,
  cosineDistance,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { items, sources, stories } from "../db/schema.js";
import {
  assignToStory,
  type ClusterItem,
  type ClusterOptions,
  type NearestStory,
  type StoryStore,
} from "./cluster.js";
import type { EmbeddingsClient } from "./embeddings.js";

/** Characters of the item text that go into the embedding input. */
const EMBED_TEXT_CHARS = 1_000;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_ITEMS = 1_000;

export interface DedupOptions extends ClusterOptions {
  db: Db;
  userId: number;
  logger: Logger;
  /** Without a client, items stay unclustered. Exact dedup does not need it. */
  embeddings: EmbeddingsClient | null;
  /** Items per database read and per embeddings call. */
  batchSize?: number;
  /** Maximum items per stage in one run. The rest waits for the next run. */
  maxItems?: number;
  /** Items older than this (by effective time) are neither embedded nor clustered. */
  itemMaxAgeMs?: number;
  now?: () => Date;
}

export interface DedupReport {
  embedded: number;
  clustered: number;
  newStories: number;
  /** True when the embeddings step failed. The run still ends normally. */
  embeddingsFailed: boolean;
}

/** The text that we embed for an item. */
export function embeddingInput(title: string, text: string | null): string {
  const body = text ? text.slice(0, EMBED_TEXT_CHARS) : "";
  return body ? `${title}\n${body}` : title;
}

/** Time of an item. A date in the future is not trusted: we cap it at the fetch time. */
export function itemTime(publishedAt: Date | null, fetchedAt: Date): Date {
  return publishedAt && publishedAt < fetchedAt ? publishedAt : fetchedAt;
}

/** SQL form of `itemTime`: a publication date in the future is capped at the fetch time. */
const effectiveTime = sql`least(coalesce(${items.publishedAt}, ${items.fetchedAt}), ${items.fetchedAt})`;

interface TimeCursor {
  at: string;
  id: number;
}

/** Keyset condition: items after the cursor in (effective time, id) order. */
function afterCursor(cursor: TimeCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    sql`${effectiveTime} > ${cursor.at}::timestamptz`,
    and(sql`${effectiveTime} = ${cursor.at}::timestamptz`, gt(items.id, cursor.id)),
  );
}

/** Keyset condition: items before the cursor in (effective time, id) order. */
function beforeCursor(cursor: TimeCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    sql`${effectiveTime} < ${cursor.at}::timestamptz`,
    and(sql`${effectiveTime} = ${cursor.at}::timestamptz`, lt(items.id, cursor.id)),
  );
}

/** Condition: the effective time is not older than the age limit. */
function notTooOld(options: Pick<DedupOptions, "itemMaxAgeMs" | "now">): SQL | undefined {
  if (options.itemMaxAgeMs === undefined) return undefined;
  const from = new Date((options.now ?? (() => new Date()))().getTime() - options.itemMaxAgeMs);
  return sql`${effectiveTime} >= ${from.toISOString()}::timestamptz`;
}

/**
 * Store embeddings for items that have none. `items.embedding` is the cache:
 * an item that has an embedding is never embedded again. Identical input texts
 * in one batch are sent once. Throws when the embeddings client fails.
 * `progress.count` shows how many items were stored before a failure.
 */
export async function embedPendingItems(
  options: Pick<
    DedupOptions,
    "db" | "userId" | "embeddings" | "batchSize" | "maxItems" | "itemMaxAgeMs" | "now"
  >,
  progress: { count: number } = { count: 0 },
): Promise<number> {
  const { db, userId, embeddings } = options;
  if (!embeddings) return 0;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  // Newest items first, so that a rate limit or the item limit never starves today's news.
  let cursor = null as TimeCursor | null;
  let done = 0;
  while (done < maxItems) {
    const rows = await db
      .select({
        id: items.id,
        title: items.title,
        text: sql<string | null>`left(${items.text}, ${EMBED_TEXT_CHARS})`,
        effectiveAt: sql<string>`${effectiveTime}::text`,
      })
      .from(items)
      .where(
        and(
          eq(items.userId, userId),
          isNull(items.embedding),
          notTooOld(options),
          beforeCursor(cursor),
        ),
      )
      .orderBy(desc(effectiveTime), desc(items.id))
      .limit(Math.min(batchSize, maxItems - done));
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    cursor = { at: last.effectiveAt, id: last.id };
    const inputs = rows.map((row) => embeddingInput(row.title, row.text));
    const unique = [...new Set(inputs)];
    const vectors = await embeddings.embed(unique);
    if (vectors.length !== unique.length) throw new Error("Embeddings count does not match input");
    const byInput = new Map(unique.map((input, i) => [input, vectors[i]!]));
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        await tx
          .update(items)
          .set({ embedding: byInput.get(inputs[i]!)! })
          .where(eq(items.id, rows[i]!.id));
      }
    });
    done += rows.length;
    progress.count = done;
  }
  return done;
}

/** `StoryStore` on PostgreSQL with pgvector. */
export function createDbStoryStore(db: Db, userId: number): StoryStore {
  return {
    async findNearest(embedding, at, windowMs): Promise<NearestStory | null> {
      const distance = cosineDistance(stories.embedding, embedding);
      const from = new Date(at.getTime() - windowMs);
      const to = new Date(at.getTime() + windowMs);
      const [row] = await db
        .select({
          storyId: stories.id,
          similarity: sql<number>`1 - (${distance})`,
          repId: items.id,
          repAt: items.publishedAt,
          repFetchedAt: items.fetchedAt,
          repTrust: sources.trust,
          repTextLength: sql<number>`coalesce(length(${items.text}), 0)`,
        })
        .from(stories)
        .innerJoin(items, eq(items.id, stories.representativeItemId))
        .innerJoin(sources, eq(sources.id, items.sourceId))
        .where(
          and(
            eq(stories.userId, userId),
            isNotNull(stories.embedding),
            gte(stories.lastItemAt, from),
            lte(stories.lastItemAt, to),
          ),
        )
        .orderBy(distance)
        .limit(1);
      if (!row) return null;
      return {
        storyId: row.storyId,
        similarity: Number(row.similarity),
        representative: {
          id: row.repId,
          trust: row.repTrust,
          at: itemTime(row.repAt, row.repFetchedAt),
          textLength: Number(row.repTextLength),
        },
      };
    },

    async createStory(item) {
      return db.transaction(async (tx) => {
        const [story] = await tx
          .insert(stories)
          .values({
            userId,
            title: item.title,
            embedding: item.embedding,
            firstSeenAt: item.at,
            lastItemAt: item.at,
            representativeItemId: item.id,
          })
          .returning({ id: stories.id });
        await tx.update(items).set({ storyId: story!.id }).where(eq(items.id, item.id));
        return story!.id;
      });
    },

    async attach(storyId, item) {
      await db.transaction(async (tx) => {
        await tx.update(items).set({ storyId }).where(eq(items.id, item.id));
        await tx
          .update(stories)
          .set({
            firstSeenAt: sql`least(${stories.firstSeenAt}, ${item.at.toISOString()}::timestamptz)`,
            lastItemAt: sql`greatest(${stories.lastItemAt}, ${item.at.toISOString()}::timestamptz)`,
          })
          .where(eq(stories.id, storyId));
      });
    },

    async setRepresentative(storyId, item) {
      // The pre-filter decision belongs to the old representative. Clear it, so that the
      // pre-filter decides the story again.
      await db
        .update(stories)
        .set({
          title: item.title,
          embedding: item.embedding,
          representativeItemId: item.id,
          prefilterStatus: null,
          prefilterReason: null,
          prefilterTopics: [],
          prefilterSimilarity: null,
          prefilterAt: null,
        })
        .where(eq(stories.id, storyId));
    },
  };
}

/** Cluster items that have an embedding and no story. Return the counts. */
export async function clusterPendingItems(
  options: Pick<
    DedupOptions,
    "db" | "userId" | "threshold" | "windowMs" | "batchSize" | "maxItems" | "itemMaxAgeMs" | "now"
  >,
  store: StoryStore = createDbStoryStore(options.db, options.userId),
): Promise<{ clustered: number; newStories: number }> {
  const { db, userId } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  // Keyset cursor on (effective time, id). The time is kept as text to keep microseconds.
  let cursor = null as TimeCursor | null;
  let clustered = 0;
  let newStories = 0;
  while (clustered < maxItems) {
    const rows = await db
      .select({
        id: items.id,
        title: items.title,
        embedding: items.embedding,
        trust: sources.trust,
        publishedAt: items.publishedAt,
        fetchedAt: items.fetchedAt,
        textLength: sql<number>`coalesce(length(${items.text}), 0)`,
        effectiveAt: sql<string>`${effectiveTime}::text`,
      })
      .from(items)
      .innerJoin(sources, eq(sources.id, items.sourceId))
      .where(
        and(
          eq(items.userId, userId),
          isNull(items.storyId),
          isNotNull(items.embedding),
          notTooOld(options),
          afterCursor(cursor),
        ),
      )
      .orderBy(asc(effectiveTime), asc(items.id))
      .limit(Math.min(batchSize, maxItems - clustered));
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    cursor = { at: last.effectiveAt, id: last.id };
    const batch: ClusterItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      embedding: row.embedding!,
      trust: row.trust,
      at: itemTime(row.publishedAt, row.fetchedAt),
      textLength: Number(row.textLength),
    }));
    // The query returns items globally oldest first, so a story grows forward in time.
    for (const item of batch) {
      const { created } = await assignToStory(store, item, options);
      if (created) newStories++;
      clustered++;
    }
  }
  return { clustered, newStories };
}

/**
 * Embed new items, then cluster them into stories. Exact dedup is not part of this run:
 * the unique constraints on `items` already drop repeated URLs and texts when the collector
 * inserts them. If the embeddings API fails, log a warning and leave the items unclustered.
 */
export async function runDedup(options: DedupOptions): Promise<DedupReport> {
  const { logger } = options;
  const report: DedupReport = {
    embedded: 0,
    clustered: 0,
    newStories: 0,
    embeddingsFailed: false,
  };
  if (!options.embeddings) {
    logger.warn("EMBEDDINGS_API_KEY is not set. Items stay unclustered.");
    report.embeddingsFailed = true;
  } else {
    try {
      const progress = { count: 0 };
      try {
        await embedPendingItems(options, progress);
      } finally {
        report.embedded = progress.count;
      }
    } catch (error) {
      report.embeddingsFailed = true;
      logger.warn({ err: error }, "Embeddings failed. Items without a vector stay unclustered.");
    }
  }
  // Items that already have a vector can still be clustered.
  const result = await clusterPendingItems(options);
  report.clustered = result.clustered;
  report.newStories = result.newStories;
  logger.info(report, "Dedup finished");
  return report;
}

/** Read the clustering threshold and window from the environment config. */
export function clusterOptionsFromEnv(env: {
  DEDUP_SIMILARITY_THRESHOLD: number;
  DEDUP_WINDOW_HOURS: number;
}): ClusterOptions {
  return {
    threshold: env.DEDUP_SIMILARITY_THRESHOLD,
    windowMs: env.DEDUP_WINDOW_HOURS * 3_600_000,
  };
}
