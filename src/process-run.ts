import type { Logger } from "pino";
import type { Db } from "./db/client.js";
import { runScoring, type ScoringOptions, type ScoringReport } from "./llm/score.js";
import { createDbScoringStore } from "./llm/score-store.js";
import type { ClusterOptions } from "./pipeline/cluster.js";
import { runDedup, type DedupReport } from "./pipeline/dedup.js";
import type { EmbeddingsClient } from "./pipeline/embeddings.js";
import { runPrefilter, type PrefilterOptions, type PrefilterReport } from "./pipeline/prefilter.js";
import type { Profile } from "./profile.js";

export interface ProcessOptions {
  db: Db;
  userId: number;
  logger: Logger;
  profile: Profile;
  /** Null when `EMBEDDINGS_API_KEY` is not set. Dedup and the pre-filter then degrade. */
  embeddings: EmbeddingsClient | null;
  cluster: ClusterOptions;
  /** Items older than this are not embedded or clustered. Undefined: no limit. */
  itemMaxAgeMs?: number;
  prefilter: PrefilterOptions;
  /** The scoring options without the store. A null provider skips scoring. */
  scoring: Omit<ScoringOptions, "store" | "logger" | "profile">;
}

export interface ProcessReport {
  dedup: DedupReport;
  prefilter: PrefilterReport;
  scoring: ScoringReport;
}

/**
 * Dedup, pre-filter and score the stories that are not scored yet. Each stage reads in
 * batches and has its own limits. A missing API key is logged and the stage degrades or is
 * skipped. A database error throws.
 */
export async function runProcess(options: ProcessOptions): Promise<ProcessReport> {
  const { db, userId, logger, profile } = options;
  const dedup = await runDedup({
    db,
    userId,
    logger,
    embeddings: options.embeddings,
    itemMaxAgeMs: options.itemMaxAgeMs,
    ...options.cluster,
  });
  const prefilter = await runPrefilter({
    db,
    userId,
    logger,
    profile,
    embeddings: options.embeddings,
    ...options.prefilter,
  });
  const scoring = await runScoring({
    ...options.scoring,
    store: createDbScoringStore(db, userId),
    logger,
    profile,
  });
  const report = { dedup, prefilter, scoring };
  logger.info(
    {
      embedded: dedup.embedded,
      clustered: dedup.clustered,
      newStories: dedup.newStories,
      passed: prefilter.passed,
      dropped: prefilter.dropped,
      scored: scoring.scored,
      invalid: scoring.invalid,
      failed: scoring.failed,
      submitted: scoring.submitted,
      scoringStatus: scoring.status,
    },
    "Processing finished",
  );
  return report;
}
