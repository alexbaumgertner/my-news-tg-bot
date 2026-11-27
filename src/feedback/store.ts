import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { digestItems, feedback, items, scores, stories, weightAdjustments } from "../db/schema.js";
import type { FeedbackAction } from "./callback.js";
import {
  clampMultiplier,
  computeAdjustments,
  nextVote,
  NO_ADJUSTMENTS,
  type Adjustments,
  type FeedbackConfig,
  type Vote,
} from "./rules.js";

/** What happened to a vote. `not_found`: the item does not exist for this user. */
export type VoteOutcome = { status: "not_found" } | { status: "stored"; vote: Vote | null };

/** Stores votes. The bot uses it, and tests can fake it. */
export interface FeedbackStore {
  /** Apply a button press. A repeated press of the same vote clears it. */
  press(userId: number, action: FeedbackAction): Promise<VoteOutcome>;
}

export function createDbFeedbackStore(db: Db, config: FeedbackConfig): FeedbackStore {
  return {
    async press(userId, action) {
      return db.transaction(async (tx) => {
        // One vote at a time per user, so that the recompute sees every vote.
        await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
        const [item] = await tx
          .select({ id: digestItems.id, storyId: digestItems.storyId })
          .from(digestItems)
          .where(
            and(
              eq(digestItems.userId, userId),
              eq(digestItems.digestId, action.digestId),
              eq(digestItems.position, action.position),
            ),
          );
        if (!item) return { status: "not_found" } as const;

        const [existing] = await tx
          .select({ id: feedback.id, kind: feedback.kind })
          .from(feedback)
          .where(and(eq(feedback.userId, userId), eq(feedback.digestItemId, item.id)));
        const current = existing?.kind === "up" || existing?.kind === "down" ? existing.kind : null;
        const vote = nextVote(current, action.vote);

        if (vote === null) {
          if (existing) await tx.delete(feedback).where(eq(feedback.id, existing.id));
        } else if (existing) {
          // Keep the story, topics and source of the first vote. Only the vote changes.
          await tx
            .update(feedback)
            .set({ kind: vote, updatedAt: new Date() })
            .where(eq(feedback.id, existing.id));
        } else {
          const snapshot = await snapshotStory(tx, userId, item.storyId);
          await tx.insert(feedback).values({
            userId,
            digestItemId: item.id,
            kind: vote,
            storyId: item.storyId,
            ...snapshot,
          });
        }
        await recomputeAdjustments(tx, userId, config);
        return { status: "stored", vote } as const;
      });
    },
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The topics and the source of a story now. The score of the current representative wins. */
async function snapshotStory(
  tx: Tx,
  userId: number,
  storyId: number,
): Promise<{ topics: string[]; sourceId: number | null }> {
  const [story] = await tx
    .select({
      prefilterTopics: stories.prefilterTopics,
      representativeItemId: stories.representativeItemId,
      sourceId: items.sourceId,
    })
    .from(stories)
    .leftJoin(items, eq(items.id, stories.representativeItemId))
    .where(and(eq(stories.userId, userId), eq(stories.id, storyId)));
  if (!story) return { topics: [], sourceId: null };
  const [score] = await tx
    .select({ topics: scores.topics })
    .from(scores)
    .where(
      and(
        eq(scores.userId, userId),
        eq(scores.storyId, storyId),
        story.representativeItemId === null
          ? sql`false`
          : eq(scores.representativeItemId, story.representativeItemId),
      ),
    )
    .orderBy(sql`${scores.createdAt} desc`, sql`${scores.id} desc`)
    .limit(1);
  return { topics: score?.topics ?? story.prefilterTopics, sourceId: story.sourceId };
}

/** Rewrite `weight_adjustments` of the user from all stored votes. */
async function recomputeAdjustments(tx: Tx, userId: number, config: FeedbackConfig): Promise<void> {
  const votes = await tx
    .select({ kind: feedback.kind, topics: feedback.topics, sourceId: feedback.sourceId })
    .from(feedback)
    .where(eq(feedback.userId, userId));
  const result = computeAdjustments(
    votes.flatMap((v) =>
      v.kind === "up" || v.kind === "down"
        ? [{ kind: v.kind, topics: v.topics, sourceId: v.sourceId }]
        : [],
    ),
    config,
  );
  const rows = [
    ...[...result.topics].map(([key, multiplier]) => ({
      userId,
      dimension: "topic",
      key,
      multiplier,
    })),
    ...[...result.sources].map(([id, multiplier]) => ({
      userId,
      dimension: "source",
      key: String(id),
      multiplier,
    })),
  ];
  await tx.delete(weightAdjustments).where(eq(weightAdjustments.userId, userId));
  if (rows.length > 0) await tx.insert(weightAdjustments).values(rows);
}

/**
 * The stored multipliers of a user, clamped to the current bounds. Used by the ranking.
 * A row with an unknown shape is skipped.
 */
export async function loadAdjustments(
  db: Db,
  userId: number,
  config: FeedbackConfig,
): Promise<Adjustments> {
  const rows = await db
    .select({
      dimension: weightAdjustments.dimension,
      key: weightAdjustments.key,
      multiplier: weightAdjustments.multiplier,
    })
    .from(weightAdjustments)
    .where(eq(weightAdjustments.userId, userId));
  if (rows.length === 0) return NO_ADJUSTMENTS;
  const topics = new Map<string, number>();
  const sources = new Map<number, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.multiplier)) continue;
    if (row.dimension === "topic") {
      topics.set(row.key, clampMultiplier(row.multiplier, config.topicMin, config.topicMax));
    } else if (row.dimension === "source") {
      const id = Number(row.key);
      if (Number.isSafeInteger(id)) {
        sources.set(id, clampMultiplier(row.multiplier, config.sourceMin, config.sourceMax));
      }
    }
  }
  return { topics, sources };
}
