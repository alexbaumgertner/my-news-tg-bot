import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { items, sources, stories } from "../db/schema.js";
import type { Profile } from "../profile.js";
import { cosineSimilarity } from "./cluster.js";
import type { EmbeddingsClient } from "./embeddings.js";

/** Characters of the item text that the keyword rules read. */
const MATCH_TEXT_CHARS = 4_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_STORIES = 5_000;
const DEFAULT_CACHE_TTL_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

/** Letters and digits of any script. This pattern is fixed. It is never built from text. */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const CYRILLIC = /^[Ѐ-ӿ]+$/u;

/** Lower-case a word and fold "ё" into "е", so that both spellings match. */
function foldWord(word: string): string {
  return word.toLowerCase().replaceAll("ё", "е");
}

/** Split text into folded words. Stop after `maxWords` words. */
export function tokenize(text: string, maxWords = 2_000): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    words.push(foldWord(match[0]));
    if (words.length >= maxWords) break;
  }
  return words;
}

/**
 * Test one text word against one keyword word.
 * - Equal words match.
 * - Latin: a keyword of 4+ letters also matches the word with up to 2 more letters
 *   (plural and similar endings).
 * - Cyrillic: a keyword of 5+ letters loses its last 2 letters, and that stem matches
 *   words with up to 3 more letters (case and number endings).
 */
function wordMatches(keywordWord: string, textWord: string): boolean {
  if (keywordWord === textWord) return true;
  if (CYRILLIC.test(keywordWord)) {
    if (keywordWord.length < 5) return false;
    const stem = keywordWord.slice(0, -2);
    return textWord.startsWith(stem) && textWord.length - stem.length <= 3;
  }
  if (keywordWord.length < 4) return false;
  return textWord.startsWith(keywordWord) && textWord.length - keywordWord.length <= 2;
}

/** Match a list of keywords against text. Build it once per profile. */
export class KeywordMatcher {
  private readonly entries: { keyword: string; words: string[] }[];

  /** Keywords come from the profile. They are never used to build a regular expression. */
  constructor(keywords: readonly string[]) {
    this.entries = keywords
      .map((keyword) => ({ keyword, words: tokenize(keyword) }))
      .filter((entry) => entry.words.length > 0);
  }

  /** Return the first keyword that occurs in `text`, or null. */
  find(text: string): string | null {
    return this.findInWords(tokenize(text));
  }

  /** Same as `find`, for text that is already split into words. */
  findInWords(textWords: readonly string[]): string | null {
    for (const { keyword, words } of this.entries) {
      const last = textWords.length - words.length;
      for (let start = 0; start <= last; start++) {
        if (words.every((word, offset) => wordMatches(word, textWords[start + offset]!))) {
          return keyword;
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Topic embeddings cache
// ---------------------------------------------------------------------------

export interface TopicEmbeddingCacheOptions {
  /** Time to live of one entry. Default: 24 hours. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * In-process cache of topic description embeddings. The key is a hash of the description,
 * so an edited description gets a new vector. Each entry expires after `ttlMs`.
 */
export class TopicEmbeddingCache {
  private readonly entries = new Map<string, { vector: number[]; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TopicEmbeddingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  static key(description: string): string {
    return createHash("sha256").update(description).digest("hex");
  }

  /** Return the vectors for `descriptions`, in order. Call the client only for missing ones. */
  async getMany(descriptions: string[], client: EmbeddingsClient): Promise<number[][]> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const missing = [
      ...new Set(descriptions.filter((d) => !this.entries.has(TopicEmbeddingCache.key(d)))),
    ];
    if (missing.length > 0) {
      const vectors = await client.embed(missing);
      if (vectors.length !== missing.length) {
        throw new Error("Embeddings count does not match input");
      }
      missing.forEach((description, i) => {
        this.entries.set(TopicEmbeddingCache.key(description), {
          vector: vectors[i]!,
          expiresAt: now + this.ttlMs,
        });
      });
    }
    return descriptions.map((d) => this.entries.get(TopicEmbeddingCache.key(d))!.vector);
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type PrefilterReason =
  "safety" | "hard_exclusion" | "stop_word" | "keyword" | "similarity" | "fail_open" | "no_match";

export interface PrefilterDecision {
  status: "passed" | "dropped";
  reason: PrefilterReason;
  /** Topic ids: keyword matches, or the best topic by similarity. */
  topicIds: string[];
  /** Cosine similarity to the best topic. Null when it was not computed. */
  similarity: number | null;
  /** The keyword that decided the story, for logs and tests. */
  matched?: string;
}

export interface PrefilterStory {
  title: string;
  text: string | null;
  /** Story embedding. Null when the story has none. */
  embedding: number[] | null;
}

export interface PrefilterOptions {
  /** Minimum cosine similarity to a topic description. */
  minSimilarity: number;
  /** A topic with weight 1 lowers the minimum by this value. Lower weights lower it less. */
  weightDiscount: number;
}

/**
 * Topic description vectors, in the order of `profile.topics`.
 * Null means "not available": the embeddings API failed or has no key. Rule 4 then fails open.
 */
export type TopicVectors = number[][] | null;

/** The matchers and options for one profile. Build it once, then call `decide` per story. */
export class Prefilter {
  private readonly safety: KeywordMatcher;
  private readonly hardExclusions: KeywordMatcher;
  private readonly topics: {
    id: string;
    weight: number;
    stopWords: KeywordMatcher;
    keywords: KeywordMatcher;
  }[];

  constructor(
    private readonly profile: Profile,
    private readonly options: PrefilterOptions,
  ) {
    this.safety = new KeywordMatcher(profile.safety_exception.keywords);
    this.hardExclusions = new KeywordMatcher(profile.hard_exclusions.keywords);
    this.topics = profile.topics.map((topic) => ({
      id: topic.id,
      weight: topic.weight,
      stopWords: new KeywordMatcher(topic.stop_words ?? []),
      keywords: new KeywordMatcher(topic.keywords),
    }));
  }

  /** The minimum similarity for a topic. A heavier topic has a lower bar. */
  thresholdFor(weight: number): number {
    return this.options.minSimilarity - this.options.weightDiscount * weight;
  }

  /** Rules 1-3. Return null when none of them decides. */
  private decideByKeywords(words: readonly string[]): PrefilterDecision | null {
    const safe = this.safety.findInWords(words);
    if (safe !== null) {
      return { status: "passed", reason: "safety", topicIds: [], similarity: null, matched: safe };
    }
    const excluded = this.hardExclusions.findInWords(words);
    if (excluded !== null) {
      return {
        status: "dropped",
        reason: "hard_exclusion",
        topicIds: [],
        similarity: null,
        matched: excluded,
      };
    }
    for (const topic of this.topics) {
      const stop = topic.stopWords.findInWords(words);
      if (stop !== null) {
        return {
          status: "dropped",
          reason: "stop_word",
          topicIds: [topic.id],
          similarity: null,
          matched: stop,
        };
      }
    }
    const topicIds = this.topics
      .filter((topic) => topic.keywords.findInWords(words) !== null)
      .map((topic) => topic.id);
    if (topicIds.length > 0) {
      return { status: "passed", reason: "keyword", topicIds, similarity: null };
    }
    return null;
  }

  /** Apply the five rules, in order, to one story. */
  decide(story: PrefilterStory, topicVectors: TopicVectors): PrefilterDecision {
    const text = `${story.title}\n${(story.text ?? "").slice(0, MATCH_TEXT_CHARS)}`;
    const byKeyword = this.decideByKeywords(tokenize(text));
    if (byKeyword) return byKeyword;
    // Rule 4. Without vectors, fail open: the later stages have budget caps.
    if (!topicVectors || !story.embedding) {
      return { status: "passed", reason: "fail_open", topicIds: [], similarity: null };
    }
    let best: { id: string; similarity: number; margin: number } | null = null;
    this.topics.forEach((topic, i) => {
      const similarity = cosineSimilarity(story.embedding!, topicVectors[i]!);
      const margin = similarity - this.thresholdFor(topic.weight);
      if (!best || margin > best.margin) best = { id: topic.id, similarity, margin };
    });
    const top = best as { id: string; similarity: number; margin: number } | null;
    if (top && top.margin >= 0) {
      return {
        status: "passed",
        reason: "similarity",
        topicIds: [top.id],
        similarity: top.similarity,
      };
    }
    return {
      status: "dropped",
      reason: "no_match",
      topicIds: top ? [top.id] : [],
      similarity: top?.similarity ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Run on the database
// ---------------------------------------------------------------------------

export interface PrefilterRunOptions extends PrefilterOptions {
  db: Db;
  userId: number;
  logger: Logger;
  profile: Profile;
  /** Without a client, rule 4 fails open. */
  embeddings: EmbeddingsClient | null;
  cache?: TopicEmbeddingCache;
  /** Stories per database read. */
  batchSize?: number;
  /** Maximum stories in one run. The rest waits for the next run. */
  maxStories?: number;
}

export interface PrefilterReport {
  passed: number;
  dropped: number;
  /** True when rule 4 failed open because of the embeddings client. */
  embeddingsFailed: boolean;
  /** Counts per source slug and reason. */
  bySource: Record<string, Partial<Record<PrefilterReason, number>>>;
}

/** Read the pre-filter options from the environment config. */
export function prefilterOptionsFromEnv(env: {
  PREFILTER_MIN_SIMILARITY: number;
  PREFILTER_WEIGHT_DISCOUNT: number;
}): PrefilterOptions {
  return {
    minSimilarity: env.PREFILTER_MIN_SIMILARITY,
    weightDiscount: env.PREFILTER_WEIGHT_DISCOUNT,
  };
}

/**
 * Decide every story that has no decision yet, and store the decision on the story.
 * Stories are read in batches. The topic vectors are loaded once, when the first story
 * needs rule 4. If that fails, the rest of the run fails open.
 */
export async function runPrefilter(options: PrefilterRunOptions): Promise<PrefilterReport> {
  const { db, userId, logger, profile, embeddings } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxStories = options.maxStories ?? DEFAULT_MAX_STORIES;
  const cache = options.cache ?? new TopicEmbeddingCache();
  const prefilter = new Prefilter(profile, options);
  const report: PrefilterReport = {
    passed: 0,
    dropped: 0,
    embeddingsFailed: false,
    bySource: {},
  };

  let topicVectors: TopicVectors = null;
  let vectorsTried = false;
  const loadVectors = async (): Promise<TopicVectors> => {
    if (vectorsTried) return topicVectors;
    vectorsTried = true;
    if (!embeddings) {
      report.embeddingsFailed = true;
      logger.warn(
        "EMBEDDINGS_API_KEY is not set. The pre-filter passes stories that no keyword decides.",
      );
      return null;
    }
    try {
      topicVectors = await cache.getMany(
        profile.topics.map((topic) => topic.description),
        embeddings,
      );
    } catch (error) {
      report.embeddingsFailed = true;
      logger.warn(
        { err: error },
        "Topic embeddings failed. The pre-filter passes stories that no keyword decides.",
      );
    }
    return topicVectors;
  };

  let cursor = 0;
  let done = 0;
  while (done < maxStories) {
    const rows = await db
      .select({
        id: stories.id,
        title: stories.title,
        embedding: stories.embedding,
        text: sql<string | null>`left(${items.text}, ${MATCH_TEXT_CHARS})`,
        source: sources.slug,
      })
      .from(stories)
      .leftJoin(items, eq(items.id, stories.representativeItemId))
      .leftJoin(sources, eq(sources.id, items.sourceId))
      .where(
        and(eq(stories.userId, userId), isNull(stories.prefilterStatus), gt(stories.id, cursor)),
      )
      .orderBy(asc(stories.id))
      .limit(Math.min(batchSize, maxStories - done));
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const decisions: { id: number; source: string; decision: PrefilterDecision }[] = [];
    for (const row of rows) {
      const story: PrefilterStory = {
        title: row.title,
        text: row.text,
        embedding: row.embedding,
      };
      let decision = prefilter.decide(story, null);
      // Only the stories that reach rule 4 need the topic vectors.
      if (decision.reason === "fail_open" && story.embedding) {
        const vectors = await loadVectors();
        if (vectors) decision = prefilter.decide(story, vectors);
      }
      decisions.push({ id: row.id, source: row.source ?? "unknown", decision });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      for (const { id, decision } of decisions) {
        await tx
          .update(stories)
          .set({
            prefilterStatus: decision.status,
            prefilterReason: decision.reason,
            prefilterTopics: decision.topicIds,
            prefilterSimilarity: decision.similarity,
            prefilterAt: now,
          })
          .where(eq(stories.id, id));
      }
    });
    for (const { source, decision } of decisions) {
      report[decision.status]++;
      const counts = (report.bySource[source] ??= {});
      counts[decision.reason] = (counts[decision.reason] ?? 0) + 1;
    }
    done += rows.length;
  }

  for (const [source, reasons] of Object.entries(report.bySource)) {
    logger.info({ source, reasons }, "Pre-filter result per source");
  }
  logger.info(
    { passed: report.passed, dropped: report.dropped, embeddingsFailed: report.embeddingsFailed },
    "Pre-filter finished",
  );
  return report;
}
