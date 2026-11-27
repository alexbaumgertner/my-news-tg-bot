import { and, count, desc, eq, gte, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { items, llmBatches, llmUsage, scores, stories } from "../db/schema.js";
import type { LlmUsage } from "./provider.js";
import type { StoryScore } from "./score-schema.js";

export interface Candidate {
  storyId: number;
  itemId: number;
  title: string;
  /** The item text, already cut to the character limit. */
  text: string | null;
}

export interface BatchEntry {
  customId: string;
  storyId: number;
  itemId: number;
}

export interface PendingBatch {
  id: number;
  providerBatchId: string;
  entries: BatchEntry[];
  model: string;
  promptVersion: string;
}

export interface ScoreMeta {
  model: string;
  promptVersion: string;
}

/** The `llm_usage.purpose` values. Scoring and composing share one budget. */
export type UsagePurpose = "score" | "compose";

/** What the composer needs from the store: the shared spend and the usage rows. */
export type UsageStore = Pick<ScoringStore, "spentSince" | "recordUsage">;

/** Everything that scoring reads and writes. The database implements it; tests may fake it. */
export interface ScoringStore {
  /** Total cost in USD of all LLM purposes since `since`. */
  spentSince(since: Date): Promise<number>;
  /** Number of scoring answers paid for since `since`. */
  scoredCallsSince(since: Date): Promise<number>;
  pendingBatches(): Promise<PendingBatch[]>;
  /**
   * Stories that passed the pre-filter and have no score for their representative item.
   * Stories whose output was invalid for that item are left out. Newest first.
   */
  findCandidates(limit: number, maxChars: number): Promise<Candidate[]>;
  saveScore(
    candidate: Pick<Candidate, "storyId" | "itemId">,
    score: StoryScore,
    meta: ScoreMeta,
  ): Promise<void>;
  /** Remember that the output for this item was invalid, so scoring does not repeat it. */
  markFailed(candidate: Pick<Candidate, "storyId" | "itemId">): Promise<void>;
  /**
   * Record the usage of one answer. With an `entryKey`, a second call with the same key
   * records nothing and returns false. The purpose defaults to "score".
   */
  recordUsage(
    model: string,
    usage: LlmUsage,
    costUsd: number,
    entryKey?: string,
    purpose?: UsagePurpose,
  ): Promise<boolean>;
  saveBatch(batch: { providerBatchId: string; entries: BatchEntry[] } & ScoreMeta): Promise<void>;
  endBatch(id: number): Promise<void>;
}

export function createDbScoringStore(db: Db, userId: number): ScoringStore {
  return {
    async spentSince(since) {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${llmUsage.costUsd}), 0)` })
        .from(llmUsage)
        .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)));
      return Number(row?.total ?? 0);
    },

    async scoredCallsSince(since) {
      const [row] = await db
        .select({ n: count() })
        .from(llmUsage)
        .where(
          and(
            eq(llmUsage.userId, userId),
            eq(llmUsage.purpose, "score"),
            gte(llmUsage.createdAt, since),
          ),
        );
      return row?.n ?? 0;
    },

    async pendingBatches() {
      const rows = await db
        .select()
        .from(llmBatches)
        .where(and(eq(llmBatches.userId, userId), eq(llmBatches.status, "pending")));
      return rows.map((r) => ({
        id: r.id,
        providerBatchId: r.providerBatchId,
        entries: r.entries,
        model: r.model,
        promptVersion: r.promptVersion,
      }));
    },

    async findCandidates(limit, maxChars) {
      if (limit <= 0) return [];
      return db
        .select({
          storyId: stories.id,
          itemId: items.id,
          title: items.title,
          text: sql<string | null>`left(${items.text}, ${maxChars})`,
        })
        .from(stories)
        .innerJoin(items, eq(items.id, stories.representativeItemId))
        .where(
          and(
            eq(stories.userId, userId),
            eq(stories.prefilterStatus, "passed"),
            or(isNull(stories.scoreFailedItemId), ne(stories.scoreFailedItemId, items.id)),
            notExists(
              db
                .select({ one: sql`1` })
                .from(scores)
                .where(
                  and(eq(scores.storyId, stories.id), eq(scores.representativeItemId, items.id)),
                ),
            ),
          ),
        )
        .orderBy(desc(stories.lastItemAt), desc(stories.id))
        .limit(limit);
    },

    async saveScore(candidate, score, meta) {
      const values = {
        userId,
        storyId: candidate.storyId,
        topics: score.topics,
        relevance: score.relevance,
        impact: score.impact,
        whyMe: score.why_me,
        novelty: score.novelty,
        confidence: score.confidence,
        isRussiaDomestic: score.is_russia_domestic,
        studyType: score.study_type,
        representativeItemId: candidate.itemId,
        model: meta.model,
        promptVersion: meta.promptVersion,
      };
      await db
        .insert(scores)
        .values(values)
        .onConflictDoUpdate({
          target: [scores.storyId, scores.promptVersion],
          set: { ...values, createdAt: new Date() },
        });
    },

    async markFailed(candidate) {
      await db
        .update(stories)
        .set({ scoreFailedItemId: candidate.itemId })
        .where(and(eq(stories.id, candidate.storyId), eq(stories.userId, userId)));
    },

    async recordUsage(model, usage, costUsd, entryKey, purpose = "score") {
      const rows = await db
        .insert(llmUsage)
        .values({
          userId,
          purpose,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: costUsd.toFixed(6),
          batchEntryKey: entryKey ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: llmUsage.id });
      return rows.length > 0;
    },

    async saveBatch(batch) {
      await db.insert(llmBatches).values({
        userId,
        providerBatchId: batch.providerBatchId,
        model: batch.model,
        promptVersion: batch.promptVersion,
        entries: batch.entries,
      });
    },

    async endBatch(id) {
      await db
        .update(llmBatches)
        .set({ status: "ended", endedAt: new Date() })
        .where(and(eq(llmBatches.id, id), eq(llmBatches.userId, userId)));
    },
  };
}
