import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import { digestItems, digests, items, scores, sources, stories } from "../db/schema.js";
import type { ComposeStory } from "../llm/compose-schema.js";
import { rankDigest, type RankOptions } from "../pipeline/rank.js";
import type { Profile } from "../profile.js";
import type { DigestStore } from "./run.js";

export interface DbDigestStoreOptions {
  db: Db;
  userId: number;
  profile: Profile;
  windowHours: number;
  rankOptions?: RankOptions;
}

/** `DigestStore` on PostgreSQL. */
export function createDbDigestStore(options: DbDigestStoreOptions): DigestStore {
  const { db, userId } = options;
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

    rank(kind, now) {
      return rankDigest({
        db,
        userId,
        profile: options.profile,
        kind,
        now,
        windowHours: options.windowHours,
        options: options.rankOptions,
      });
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

    async createDigest(digest) {
      return db.transaction(async (tx) => {
        // A digest of this slot that was not sent is replaced. The cascade removes its items.
        await tx
          .delete(digests)
          .where(
            and(
              eq(digests.userId, userId),
              eq(digests.kind, digest.kind),
              eq(digests.digestDate, digest.date),
              isNull(digests.sentAt),
            ),
          );
        // The unique constraint rejects a second digest of the same slot and day.
        const [row] = await tx
          .insert(digests)
          .values({
            userId,
            kind: digest.kind,
            language: digest.language,
            digestDate: digest.date,
          })
          .returning({ id: digests.id });
        const digestId = row!.id;
        if (digest.items.length > 0) {
          await tx.insert(digestItems).values(
            digest.items.map((item, index) => ({
              userId,
              digestId,
              storyId: item.storyId,
              position: index + 1,
              headline: item.headline,
              summary: item.summary,
              whyMe: item.whyMe,
              url: item.url,
            })),
          );
        }
        return digestId;
      });
    },

    async markSent(digestId, messageIds, sentAt) {
      await db
        .update(digests)
        .set({ sentAt, telegramMessageIds: messageIds })
        .where(and(eq(digests.id, digestId), eq(digests.userId, userId)));
    },
  };
}
