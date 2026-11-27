import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

/** Size of embedding vectors. Must match the embeddings model. See docs/DB.md. */
export const EMBEDDING_DIMENSIONS = 1024;

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
// Telegram user ids do not fit in int32, so use bigint.
const userId = () => bigint("user_id", { mode: "number" }).notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const sources = pgTable(
  "sources",
  {
    id: id(),
    userId: userId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    url: text("url").notNull(),
    language: text("language").notNull(),
    topics: text("topics")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    trust: smallint("trust").notNull(),
    pollInterval: text("poll_interval").notNull(),
    active: boolean("active").notNull(),
    verified: boolean("verified"),
    notes: text("notes"),
    initialLookbackDays: integer("initial_lookback_days"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    etag: text("etag"),
    lastModified: text("last_modified"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sources_user_slug_uq").on(t.userId, t.slug),
    check("sources_trust_ck", sql`${t.trust} between 1 and 5`),
  ],
);

export const stories = pgTable(
  "stories",
  {
    id: id(),
    userId: userId(),
    title: text("title").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Time of the newest item in the story. The clustering window counts from it. */
    lastItemAt: timestamp("last_item_at", { withTimezone: true }).notNull().defaultNow(),
    /** The best item of the story. Its title and embedding are copied to the story. */
    representativeItemId: bigint("representative_item_id", { mode: "number" }).references(
      (): AnyPgColumn => items.id,
      { onDelete: "set null" },
    ),
    /** Pre-filter decision: "passed" or "dropped". Null until the pre-filter has seen the story. */
    prefilterStatus: text("prefilter_status"),
    /** Why the pre-filter decided so: safety, keyword, similarity, fail_open, hard_exclusion, stop_word or no_match. */
    prefilterReason: text("prefilter_reason"),
    /** Topic ids that matched a keyword, or the best topic by similarity. */
    prefilterTopics: text("prefilter_topics")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Cosine similarity to the best topic. Null when the similarity was not computed. */
    prefilterSimilarity: real("prefilter_similarity"),
    prefilterAt: timestamp("prefilter_at", { withTimezone: true }),
    /** Representative item whose LLM output was invalid. Scoring skips it until the representative changes. */
    scoreFailedItemId: bigint("score_failed_item_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "stories_prefilter_status_ck",
      sql`${t.prefilterStatus} is null or ${t.prefilterStatus} in ('passed', 'dropped')`,
    ),
    index("stories_user_prefilter_idx").on(t.userId, t.prefilterStatus, t.id),
    index("stories_user_first_seen_idx").on(t.userId, t.firstSeenAt),
    index("stories_user_last_item_idx").on(t.userId, t.lastItemAt),
    index("stories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const items = pgTable(
  "items",
  {
    id: id(),
    userId: userId(),
    sourceId: bigint("source_id", { mode: "number" })
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    storyId: bigint("story_id", { mode: "number" }).references(() => stories.id, {
      onDelete: "set null",
    }),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    text: text("text"),
    contentHash: text("content_hash").notNull(),
    language: text("language"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  },
  (t) => [
    unique("items_user_canonical_url_uq").on(t.userId, t.canonicalUrl),
    unique("items_user_content_hash_uq").on(t.userId, t.contentHash),
    index("items_story_idx").on(t.storyId),
    index("items_source_published_idx").on(t.sourceId, t.publishedAt),
    index("items_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const scores = pgTable(
  "scores",
  {
    id: id(),
    userId: userId(),
    storyId: bigint("story_id", { mode: "number" })
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    topics: text("topics")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    relevance: smallint("relevance").notNull(),
    impact: text("impact").notNull(),
    whyMe: text("why_me").notNull(),
    novelty: real("novelty"),
    confidence: real("confidence"),
    isRussiaDomestic: boolean("is_russia_domestic").notNull().default(false),
    studyType: text("study_type"),
    rankScore: real("rank_score"),
    /** The representative item that was scored. A new representative means a new score. */
    representativeItemId: bigint("representative_item_id", { mode: "number" }).references(
      () => items.id,
      { onDelete: "set null" },
    ),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("scores_story_prompt_uq").on(t.storyId, t.promptVersion),
    index("scores_user_created_idx").on(t.userId, t.createdAt),
    check("scores_relevance_ck", sql`${t.relevance} between 0 and 10`),
  ],
);

export const digests = pgTable(
  "digests",
  {
    id: id(),
    userId: userId(),
    kind: text("kind").notNull(),
    language: text("language").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageIds: jsonb("telegram_message_ids").$type<number[]>(),
    createdAt: createdAt(),
  },
  (t) => [index("digests_user_sent_idx").on(t.userId, t.sentAt)],
);

export const digestItems = pgTable(
  "digest_items",
  {
    id: id(),
    userId: userId(),
    digestId: bigint("digest_id", { mode: "number" })
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    storyId: bigint("story_id", { mode: "number" })
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    whyMe: text("why_me"),
    url: text("url").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("digest_items_digest_story_uq").on(t.digestId, t.storyId),
    index("digest_items_story_idx").on(t.storyId),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    userId: userId(),
    digestItemId: bigint("digest_item_id", { mode: "number" })
      .notNull()
      .references(() => digestItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("feedback_user_created_idx").on(t.userId, t.createdAt)],
);

export const profileVersions = pgTable(
  "profile_versions",
  {
    id: id(),
    userId: userId(),
    version: integer("version").notNull(),
    profile: jsonb("profile").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [unique("profile_versions_user_version_uq").on(t.userId, t.version)],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: id(),
    userId: userId(),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    /** Set for a batch answer: "<provider batch id>:<custom id>". It makes a replay safe. */
    batchEntryKey: text("batch_entry_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_usage_user_created_idx").on(t.userId, t.createdAt),
    unique("llm_usage_user_batch_entry_uq").on(t.userId, t.batchEntryKey),
  ],
);

/** Stub for v1: words shown in the English block. */
export const vocabSeen = pgTable(
  "vocab_seen",
  {
    id: id(),
    userId: userId(),
    word: text("word").notNull(),
    language: text("language").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("vocab_seen_user_word_uq").on(t.userId, t.language, t.word)],
);

/** Per-user bot settings: output language and digest times. One row per user. */
export const userSettings = pgTable("user_settings", {
  userId: userId().primaryKey(),
  language: text("language").notNull().default("en"),
  /** Local times "HH:MM" for the morning and evening digests. */
  morningTime: text("morning_time").notNull().default("07:30"),
  eveningTime: text("evening_time").notNull().default("20:30"),
  timezone: text("timezone").notNull().default("Europe/Istanbul"),
  chatId: bigint("chat_id", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Batch API jobs for scoring. A later run collects the results of a pending batch. */
export const llmBatches = pgTable(
  "llm_batches",
  {
    id: id(),
    userId: userId(),
    providerBatchId: text("provider_batch_id").notNull(),
    /** "pending" until the results are stored, then "ended". */
    status: text("status").notNull().default("pending"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** One entry per request: the custom id and the story and item that it scores. */
    entries: jsonb("entries")
      .$type<{ customId: string; storyId: number; itemId: number }[]>()
      .notNull(),
    createdAt: createdAt(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    unique("llm_batches_user_provider_uq").on(t.userId, t.providerBatchId),
    index("llm_batches_user_status_idx").on(t.userId, t.status),
    check("llm_batches_status_ck", sql`${t.status} in ('pending', 'ended')`),
  ],
);
