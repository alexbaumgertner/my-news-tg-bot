import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { digestItems, digests, items, llmUsage, scores, sources, stories } from "../db/schema.js";
import type { ComposeStory } from "../llm/compose-schema.js";
import { loadAdjustments, recomputeAdjustments } from "../feedback/store.js";
import { DEFAULT_FEEDBACK_CONFIG, type FeedbackConfig } from "../feedback/rules.js";
import {
  DEFAULT_RANK_OPTIONS,
  rankDegradedDigest,
  rankDigest,
  type RankOptions,
} from "../pipeline/rank.js";
import type { Profile } from "../profile.js";
import type { DigestClaim, DigestStore } from "./run.js";

export interface DbDigestStoreOptions {
  db: Db;
  userId: number;
  profile: Profile;
  windowHours: number;
  rankOptions?: RankOptions;
  /** Bounds of the feedback multipliers. Default: the defaults of `FEEDBACK_*`. */
  feedback?: FeedbackConfig;
  /** How long a claim blocks other runs of the slot. Default: 10 minutes. */
  leaseMs?: number;
}

const DEFAULT_LEASE_MS = 10 * 60_000;

/** `DigestStore` on PostgreSQL. */
export function createDbDigestStore(options: DbDigestStoreOptions): DigestStore {
  const { db, userId } = options;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  /** The row of a claim, only while the claim is still held by this run. */
  const ownedBy = (claim: DigestClaim) =>
    and(
      eq(digests.id, claim.digestId),
      eq(digests.userId, userId),
      eq(digests.status, "claimed"),
      eq(digests.claimToken, claim.token),
    );
  /** The rank options with the multipliers of the votes. Read at each rank, so a vote counts at once. */
  const rankOptionsWithVotes = async (): Promise<RankOptions> => ({
    ...(options.rankOptions ?? DEFAULT_RANK_OPTIONS),
    adjustments: await loadAdjustments(db, userId, options.feedback ?? DEFAULT_FEEDBACK_CONFIG),
  });
  return {
    async findDigest(kind, date) {
      const [row] = await db
        .select({ id: digests.id, sentAt: digests.sentAt })
        .from(digests)
        .where(
          and(eq(digests.userId, userId), eq(digests.kind, kind), eq(digests.digestDate, date)),
        );
      return row ?? null;
    },

    async rank(kind, now) {
      return rankDigest({
        db,
        userId,
        profile: options.profile,
        kind,
        now,
        windowHours: options.windowHours,
        options: await rankOptionsWithVotes(),
      });
    },

    async rankDegraded(kind, now) {
      return rankDegradedDigest({
        db,
        userId,
        profile: options.profile,
        kind,
        now,
        windowHours: options.windowHours,
        options: await rankOptionsWithVotes(),
      });
    },

    async daySummary(since) {
      const [src] = await db
        .select({
          ok: sql<number>`count(*) filter (where ${sources.consecutiveFailures} = 0)::int`,
          failed: sql<number>`count(*) filter (where ${sources.consecutiveFailures} > 0)::int`,
        })
        .from(sources)
        .where(and(eq(sources.userId, userId), eq(sources.active, true)));
      const [collected] = await db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.userId, userId), gte(items.fetchedAt, since)));
      const [passed] = await db
        .select({ n: count() })
        .from(stories)
        .where(
          and(
            eq(stories.userId, userId),
            eq(stories.prefilterStatus, "passed"),
            gte(stories.prefilterAt, since),
          ),
        );
      const [usage] = await db
        .select({
          inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${llmUsage.costUsd}), 0)`,
        })
        .from(llmUsage)
        .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)));
      return {
        sourcesOk: src?.ok ?? 0,
        sourcesFailed: src?.failed ?? 0,
        itemsCollected: collected?.n ?? 0,
        storiesPassed: passed?.n ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: Number(usage?.costUsd ?? 0),
      };
    },

    async loadComposeStories(ranked, maxChars) {
      if (ranked.length === 0) return [];
      const ids = ranked.map((r) => r.storyId);
      const rows = await db
        .select({
          storyId: stories.id,
          title: stories.title,
          text: sql<string | null>`left(${items.text}, ${maxChars})`,
          url: items.url,
          sourceName: sources.name,
          sourceLanguage: sources.language,
          representativeItemId: stories.representativeItemId,
        })
        .from(stories)
        .innerJoin(items, eq(items.id, stories.representativeItemId))
        .innerJoin(sources, eq(sources.id, items.sourceId))
        .where(and(eq(stories.userId, userId), inArray(stories.id, ids)));
      const scoreRows = await db
        .select({
          storyId: scores.storyId,
          representativeItemId: scores.representativeItemId,
          studyType: scores.studyType,
          whyMe: scores.whyMe,
        })
        .from(scores)
        .where(and(eq(scores.userId, userId), inArray(scores.storyId, ids)))
        .orderBy(desc(scores.createdAt), desc(scores.id));
      const byId = new Map(rows.map((r) => [r.storyId, r]));
      const result: ComposeStory[] = [];
      for (const story of ranked) {
        const row = byId.get(story.storyId);
        if (!row) continue;
        // The newest score of the current representative item wins.
        const score = scoreRows.find(
          (s) => s.storyId === row.storyId && s.representativeItemId === row.representativeItemId,
        );
        result.push({
          storyId: row.storyId,
          title: row.title,
          text: row.text,
          url: row.url,
          sourceName: row.sourceName,
          sourceLanguage: row.sourceLanguage,
          topic: story.topic,
          studyType: score?.studyType ?? null,
          whyMeHint: score?.whyMe ?? null,
        });
      }
      return result;
    },

    async countFilteredOut(since, shownStoryIds) {
      const [row] = await db
        .select({ items: count(), sources: countDistinct(items.sourceId) })
        .from(items)
        .where(
          and(
            eq(items.userId, userId),
            gte(items.fetchedAt, since),
            shownStoryIds.length > 0
              ? or(isNull(items.storyId), notInArray(items.storyId, shownStoryIds))
              : undefined,
          ),
        );
      return { items: row?.items ?? 0, sources: row?.sources ?? 0 };
    },

    async claimDigest(digest, now) {
      const token = randomUUID();
      const leaseStart = new Date(now.getTime() - leaseMs);
      return db.transaction(async (tx) => {
        // One atomic statement. The insert takes a free slot. The conflict branch takes over
        // only a failed row or a claim with an expired lease. A sent row or an active claim
        // is not touched, so no row is returned and the caller does not send.
        const [row] = await tx
          .insert(digests)
          .values({
            userId,
            kind: digest.kind,
            language: digest.language,
            digestDate: digest.date,
            status: "claimed",
            claimedAt: now,
            claimToken: token,
          })
          .onConflictDoUpdate({
            target: [digests.userId, digests.kind, digests.digestDate],
            set: {
              language: digest.language,
              status: "claimed",
              claimedAt: now,
              claimToken: token,
              sentAt: null,
              telegramMessageIds: null,
            },
            setWhere: or(
              eq(digests.status, "failed"),
              and(eq(digests.status, "claimed"), lt(digests.claimedAt, leaseStart)),
            ),
          })
          .returning({ id: digests.id });
        if (!row) return null;
        // Items of an earlier attempt belong to a row that this claim took over. Delete them.
        // New rows get new ids (identity column), so a button of the earlier attempt matches
        // nothing. Votes on the deleted items go with them, so recompute the adjustments.
        const deleted = await tx
          .delete(digestItems)
          .where(eq(digestItems.digestId, row.id))
          .returning({ id: digestItems.id });
        if (deleted.length > 0) {
          await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
          await recomputeAdjustments(tx, userId, options.feedback ?? DEFAULT_FEEDBACK_CONFIG);
        }
        let itemIds: number[] = [];
        if (digest.items.length > 0) {
          const inserted = await tx
            .insert(digestItems)
            .values(
              digest.items.map((item, index) => ({
                userId,
                digestId: row.id,
                storyId: item.storyId,
                position: index + 1,
                headline: item.headline,
                summary: item.summary,
                whyMe: item.whyMe,
                url: item.url,
              })),
            )
            .returning({ id: digestItems.id, position: digestItems.position });
          itemIds = inserted.sort((a, b) => a.position - b.position).map((r) => r.id);
        }
        return { digestId: row.id, token, itemIds };
      });
    },

    async markSent(claim, messageIds, sentAt) {
      const updated = await db
        .update(digests)
        .set({ status: "sent", sentAt, telegramMessageIds: messageIds })
        .where(ownedBy(claim))
        .returning({ id: digests.id });
      if (updated.length === 0) {
        throw new Error(`Digest ${claim.digestId} was sent, but this run no longer owns its claim`);
      }
    },

    async releaseClaim(claim) {
      await db.update(digests).set({ status: "failed" }).where(ownedBy(claim));
    },
  };
}
