import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { digestItems, digests, items, scores, sources, stories } from "../db/schema.js";
import type { Profile } from "../profile.js";

export type DigestKind = "morning" | "evening";

/** Maximum number of items in one digest (SPEC section 5). */
export const DIGEST_LIMITS: Record<DigestKind, number> = { morning: 7, evening: 5 };

export interface RankOptions {
  /** Maximum items per topic. Default: 3. */
  maxPerTopic: number;
  /** A story with a lower relevance never enters a digest. This keeps quiet days short. Default: 5. */
  minRelevance: number;
  /** Hours after which freshness falls to one half. Default: 24. */
  freshnessHalfLifeHours: number;
  /** Added to the score of a story from a source with trust 5 (a primary source). Default: 0.05. */
  primarySourceBonus: number;
}

export const DEFAULT_RANK_OPTIONS: RankOptions = {
  maxPerTopic: 3,
  minRelevance: 5,
  freshnessHalfLifeHours: 24,
  primarySourceBonus: 0.05,
};

/** The highest source trust. A source with this trust is a primary source. */
export const PRIMARY_TRUST = 5;

/** Bucket for a story of the safety exception that matches no topic. It ranks first. */
export const SAFETY_BUCKET = "safety";
/** Bucket for a story that passed the pre-filter without a topic (fail-open) and has no score. */
export const GENERAL_BUCKET = "general";

export interface RankCandidate {
  storyId: number;
  title: string;
  /** Topic ids from the LLM score, best first. */
  topics: string[];
  /** 0–10. */
  relevance: number;
  isRussiaDomestic: boolean;
  /** 1–5. */
  sourceTrust: number;
  /** When the story was published. */
  publishedAt: Date;
  /** True when the pre-filter passed the story by the safety exception. Such stories rank first. */
  safety?: boolean;
  /** True when the story may use the general bucket because it has no topic and no score. */
  allowGeneral?: boolean;
}

export interface RankedStory extends RankCandidate {
  /** The topic that sets the weight and the per-topic limit. */
  topic: string;
  score: number;
}

/** Freshness in (0, 1]: 1 for a new story, 0.5 after one half-life. A future date counts as new. */
export function freshness(publishedAt: Date, now: Date, halfLifeHours: number): number {
  const ageHours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/**
 * score = relevance × topic weight × source trust × freshness + primary-source bonus.
 * Relevance and trust are scaled to 0–1, so the score is 0–1 plus the bonus.
 */
export function storyScore(
  candidate: Pick<RankCandidate, "relevance" | "sourceTrust" | "publishedAt">,
  topicWeight: number,
  now: Date,
  options: RankOptions = DEFAULT_RANK_OPTIONS,
): number {
  const bonus = candidate.sourceTrust >= PRIMARY_TRUST ? options.primarySourceBonus : 0;
  return (
    (candidate.relevance / 10) *
      topicWeight *
      (candidate.sourceTrust / PRIMARY_TRUST) *
      freshness(candidate.publishedAt, now, options.freshnessHalfLifeHours) +
    bonus
  );
}

/**
 * Choose the stories for one digest. Pure and deterministic: the same input gives the same
 * output. Ties break by story id. Stories in `sentStoryIds` are never chosen. The result can
 * be shorter than the limit and can be empty.
 */
export function selectForDigest(
  candidates: RankCandidate[],
  profile: Profile,
  kind: DigestKind,
  now: Date,
  sentStoryIds: ReadonlySet<number>,
  options: RankOptions = DEFAULT_RANK_OPTIONS,
): RankedStory[] {
  // Notice topics (books) have their own block and are not ranked.
  const weights = new Map(
    profile.topics.filter((t) => t.mode === "digest").map((t) => [t.id, t.weight]),
  );
  const ranked: RankedStory[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (sentStoryIds.has(candidate.storyId) || seen.has(candidate.storyId)) continue;
    if (candidate.isRussiaDomestic || candidate.relevance < options.minRelevance) continue;
    // A story that passed the pre-filter is never dropped only because it has no topic id.
    const matched = candidate.topics.find((id) => weights.has(id));
    // The general bucket takes only a story with no topic id. A story with known topic ids
    // (for example notice-only ones) follows the normal topic rules.
    const general = candidate.allowGeneral && candidate.topics.length === 0;
    const topic =
      matched ?? (candidate.safety ? SAFETY_BUCKET : general ? GENERAL_BUCKET : undefined);
    if (topic === undefined) continue;
    seen.add(candidate.storyId);
    const score = storyScore(candidate, weights.get(topic) ?? 1, now, options);
    if (score <= 0) continue;
    ranked.push({ ...candidate, topic, score });
  }
  // Safety-exception stories come first, so the digest limit never pushes them out.
  ranked.sort(
    (a, b) =>
      Number(b.safety === true) - Number(a.safety === true) ||
      b.score - a.score ||
      a.storyId - b.storyId,
  );

  const perTopic = new Map<string, number>();
  const chosen: RankedStory[] = [];
  for (const story of ranked) {
    if (chosen.length >= DIGEST_LIMITS[kind]) break;
    const used = perTopic.get(story.topic) ?? 0;
    // The safety bucket has no per-topic limit. The per-digest limit still applies.
    if (story.topic !== SAFETY_BUCKET && used >= options.maxPerTopic) continue;
    perTopic.set(story.topic, used + 1);
    chosen.push(story);
  }
  return chosen;
}

/** Ids of the stories that an already sent digest contains. */
export async function loadSentStoryIds(db: Db, userId: number): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ storyId: digestItems.storyId })
    .from(digestItems)
    .innerJoin(digests, eq(digests.id, digestItems.digestId))
    .where(and(eq(digestItems.userId, userId), isNotNull(digests.sentAt)));
  return new Set(rows.map((r) => r.storyId));
}

/**
 * Scored stories whose newest item is not older than `since`. A story is a candidate only if
 * it passed the pre-filter and the score belongs to its current representative item. A story
 * with several such scores (prompt versions) uses the newest one.
 */
export async function loadRankCandidates(
  db: Db,
  userId: number,
  since: Date,
): Promise<RankCandidate[]> {
  const rows = await db
    .select({
      storyId: stories.id,
      title: stories.title,
      prefilterReason: stories.prefilterReason,
      firstSeenAt: stories.firstSeenAt,
      topics: scores.topics,
      relevance: scores.relevance,
      isRussiaDomestic: scores.isRussiaDomestic,
      sourceTrust: sources.trust,
      publishedAt: items.publishedAt,
      fetchedAt: items.fetchedAt,
    })
    .from(scores)
    .innerJoin(stories, eq(stories.id, scores.storyId))
    .innerJoin(items, eq(items.id, stories.representativeItemId))
    .innerJoin(sources, eq(sources.id, items.sourceId))
    .where(
      and(
        eq(scores.userId, userId),
        gte(stories.lastItemAt, since),
        // The story must have passed the pre-filter for its current representative.
        eq(stories.prefilterStatus, "passed"),
        // The score must belong to the current representative. Else it is stale.
        eq(scores.representativeItemId, stories.representativeItemId),
      ),
    )
    .orderBy(desc(scores.createdAt), desc(scores.id));

  const byStory = new Map<number, RankCandidate>();
  for (const row of rows) {
    // Rows come newest score first, so the first row of a story wins.
    if (byStory.has(row.storyId)) continue;
    byStory.set(row.storyId, {
      storyId: row.storyId,
      title: row.title,
      topics: row.topics,
      relevance: row.relevance,
      isRussiaDomestic: row.isRussiaDomestic,
      sourceTrust: row.sourceTrust,
      publishedAt: row.publishedAt ?? row.fetchedAt,
      safety: row.prefilterReason === "safety",
    });
  }
  return [...byStory.values()];
}

/**
 * Stories for a degraded digest: every story that passed the pre-filter, with or without a
 * score. A scored story keeps its score. An unscored story takes the topics of the pre-filter
 * and the lowest relevance that the ranking accepts. The same ranking rules then apply.
 */
export async function loadDegradedCandidates(
  db: Db,
  userId: number,
  since: Date,
  unscoredRelevance: number,
): Promise<RankCandidate[]> {
  const rows = await db
    .select({
      storyId: stories.id,
      title: stories.title,
      prefilterTopics: stories.prefilterTopics,
      prefilterReason: stories.prefilterReason,
      topics: scores.topics,
      relevance: scores.relevance,
      isRussiaDomestic: scores.isRussiaDomestic,
      sourceTrust: sources.trust,
      publishedAt: items.publishedAt,
      fetchedAt: items.fetchedAt,
    })
    .from(stories)
    .innerJoin(items, eq(items.id, stories.representativeItemId))
    .innerJoin(sources, eq(sources.id, items.sourceId))
    .leftJoin(
      scores,
      and(
        eq(scores.storyId, stories.id),
        eq(scores.userId, userId),
        eq(scores.representativeItemId, stories.representativeItemId),
      ),
    )
    .where(
      and(
        eq(stories.userId, userId),
        gte(stories.lastItemAt, since),
        eq(stories.prefilterStatus, "passed"),
      ),
    )
    .orderBy(desc(stories.id), sql`${scores.createdAt} desc nulls last`, desc(scores.id));

  const byStory = new Map<number, RankCandidate>();
  for (const row of rows) {
    // Rows of a story come newest score first, so the first row wins.
    if (byStory.has(row.storyId)) continue;
    byStory.set(row.storyId, {
      storyId: row.storyId,
      title: row.title,
      topics: row.topics ?? row.prefilterTopics,
      relevance: row.relevance ?? unscoredRelevance,
      isRussiaDomestic: row.isRussiaDomestic ?? false,
      sourceTrust: row.sourceTrust,
      publishedAt: row.publishedAt ?? row.fetchedAt,
      safety: row.prefilterReason === "safety",
      allowGeneral: row.relevance === null,
    });
  }
  return [...byStory.values()];
}

/** Rank for a degraded digest. Same rules and limits as `rankDigest`, but no score is needed. */
export async function rankDegradedDigest(params: {
  db: Db;
  userId: number;
  profile: Profile;
  kind: DigestKind;
  now: Date;
  windowHours?: number;
  options?: RankOptions;
}): Promise<RankedStory[]> {
  const options = params.options ?? DEFAULT_RANK_OPTIONS;
  const since = new Date(params.now.getTime() - (params.windowHours ?? 24) * 3_600_000);
  const [candidates, sent] = await Promise.all([
    loadDegradedCandidates(params.db, params.userId, since, options.minRelevance),
    loadSentStoryIds(params.db, params.userId),
  ]);
  return selectForDigest(candidates, params.profile, params.kind, params.now, sent, options);
}

/** Rank the stories of the last `windowHours` hours and return the digest selection. */
export async function rankDigest(params: {
  db: Db;
  userId: number;
  profile: Profile;
  kind: DigestKind;
  now: Date;
  windowHours?: number;
  options?: RankOptions;
}): Promise<RankedStory[]> {
  const since = new Date(params.now.getTime() - (params.windowHours ?? 24) * 3_600_000);
  const [candidates, sent] = await Promise.all([
    loadRankCandidates(params.db, params.userId, since),
    loadSentStoryIds(params.db, params.userId),
  ]);
  return selectForDigest(
    candidates,
    params.profile,
    params.kind,
    params.now,
    sent,
    params.options ?? DEFAULT_RANK_OPTIONS,
  );
}
