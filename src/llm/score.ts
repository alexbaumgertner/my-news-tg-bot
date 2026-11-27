import type { Logger } from "pino";
import type { Profile } from "../profile.js";
import { costUsd, estimateCostUsd, type Pricing } from "./pricing.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.js";
import { buildScorePrompt, parseScore, renderStory, type ScorePrompt } from "./score-schema.js";
import type { BatchEntry, Candidate, ScoringStore } from "./score-store.js";

/** Stop a sync run after this many provider errors in a row. */
const MAX_CONSECUTIVE_ERRORS = 3;

export type ScoringStopReason = "daily_cap" | "daily_budget" | "monthly_budget" | "provider_errors";

export interface ScoringReport {
  status: "ok" | "no_api_key";
  /** Scores stored in this run. */
  scored: number;
  /** Answers that failed validation. They are logged and skipped. */
  invalid: number;
  /** Requests that the provider or a batch entry rejected. */
  failed: number;
  /** Stories sent in a new batch in this run. */
  submitted: number;
  /** Pending batches that ended and were read in this run. */
  batchesCollected: number;
  stopReason: ScoringStopReason | null;
}

export interface ScoringOptions {
  store: ScoringStore;
  /** Null when `ANTHROPIC_API_KEY` is not set. */
  provider: LlmProvider | null;
  logger: Logger;
  profile: Profile;
  model: string;
  mode: "batch" | "sync";
  dailyCap: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  maxChars: number;
  maxOutputTokens: number;
  pricing: Pricing;
  /** Test hook. Default: the prompt file. */
  prompt?: ScorePrompt;
  now?: () => Date;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function customIdFor(candidate: Pick<Candidate, "storyId" | "itemId">): string {
  return `s${candidate.storyId}-i${candidate.itemId}`;
}

/**
 * Score the stories that passed the pre-filter.
 * - Without a provider: log an error and return. Never throw.
 * - Batch mode: read the pending batches that ended, then send one new batch.
 * - Sync mode: one call per story.
 * The daily cap and both budgets stop the run before the next request.
 */
export async function runScoring(options: ScoringOptions): Promise<ScoringReport> {
  const { store, provider, logger, profile } = options;
  const report: ScoringReport = {
    status: "ok",
    scored: 0,
    invalid: 0,
    failed: 0,
    submitted: 0,
    batchesCollected: 0,
    stopReason: null,
  };
  if (!provider) {
    logger.error("ANTHROPIC_API_KEY is not set. LLM scoring is skipped.");
    report.status = "no_api_key";
    return report;
  }

  const now = options.now ?? (() => new Date());
  const prompt = options.prompt ?? buildScorePrompt(profile);
  const topicIds = new Set(profile.topics.map((t) => t.id));
  const meta = { model: options.model, promptVersion: prompt.version };

  /** Validate one answer and store it. Invalid output is logged and skipped. */
  const handleAnswer = async (
    candidate: Pick<Candidate, "storyId" | "itemId">,
    response: LlmResponse,
    batch: boolean,
    scoreMeta: { model: string; promptVersion: string },
  ): Promise<void> => {
    await store.recordUsage(
      scoreMeta.model,
      response.usage,
      costUsd(response.usage, options.pricing, batch),
    );
    const parsed = parseScore(response.text, topicIds);
    if (!parsed.ok) {
      report.invalid++;
      logger.warn(
        { storyId: candidate.storyId, itemId: candidate.itemId, error: parsed.error },
        "Invalid scoring output. The story is skipped.",
      );
      await store.markFailed(candidate);
      return;
    }
    await store.saveScore(candidate, parsed.score, scoreMeta);
    report.scored++;
  };

  // 1. Read the pending batches. The results cost money, so record them before anything else.
  let pending = await store.pendingBatches();
  for (const batch of pending) {
    try {
      const status = await provider.getBatch(batch.providerBatchId);
      if (status.status !== "ended") continue;
      const byId = new Map(batch.entries.map((e) => [e.customId, e]));
      for (const result of status.results) {
        const entry = byId.get(result.customId);
        if (!entry) {
          logger.warn({ customId: result.customId }, "Batch result has an unknown custom id");
          continue;
        }
        if (!result.ok) {
          // No usage is recorded for it. The story is scored again in a later run.
          report.failed++;
          logger.warn({ ...entry, error: result.error }, "Batch entry failed");
          continue;
        }
        await handleAnswer(entry, result.response, true, {
          model: batch.model,
          promptVersion: batch.promptVersion,
        });
      }
      await store.endBatch(batch.id);
      report.batchesCollected++;
    } catch (error) {
      logger.error({ err: error, batchId: batch.providerBatchId }, "Cannot read the batch");
    }
  }
  pending = await store.pendingBatches();
  const pendingEntries: BatchEntry[] = pending.flatMap((b) => b.entries);
  const pendingStoryIds = new Set(pendingEntries.map((e) => e.storyId));

  // 2. Work out how many stories may be sent now.
  const batchMode = options.mode === "batch";
  const requestFor = (candidate: Candidate): LlmRequest => ({
    model: options.model,
    system: prompt.system,
    user: renderStory(candidate.title, candidate.text, options.maxChars),
    maxTokens: options.maxOutputTokens,
  });
  const estimate = estimateCostUsd(
    options.pricing,
    {
      systemChars: prompt.system.length,
      // The title is not cut. 500 characters is a high estimate for it.
      userChars: options.maxChars + 500,
      maxOutputTokens: options.maxOutputTokens,
    },
    batchMode,
  );
  const clock = now();
  let spentDay = await store.spentSince(startOfUtcDay(clock));
  let spentMonth = await store.spentSince(startOfUtcMonth(clock));
  const callsToday = await store.scoredCallsSince(startOfUtcDay(clock));
  // A story in a pending batch will be paid for. Count it now.
  const reserved = pendingEntries.length * estimate;
  const capLeft = Math.max(0, options.dailyCap - callsToday - pendingEntries.length);
  const dayRoom = options.dailyLimitUsd - spentDay - reserved;
  const monthRoom = options.monthlyLimitUsd - spentMonth - reserved;
  const budgetLeft = Math.max(0, Math.floor(Math.min(dayRoom, monthRoom) / estimate));
  const limit = Math.min(capLeft, budgetLeft);
  const limitReason: ScoringStopReason =
    capLeft <= budgetLeft ? "daily_cap" : dayRoom <= monthRoom ? "daily_budget" : "monthly_budget";

  const fetched = await store.findCandidates(limit + pendingStoryIds.size, options.maxChars);
  const candidates = fetched.filter((c) => !pendingStoryIds.has(c.storyId)).slice(0, limit);
  // The limit stopped the run only when it cut the list.
  if (candidates.length >= limit) {
    report.stopReason = limitReason;
    logger.warn(
      { limit: limitReason, callsToday, spentDay, spentMonth },
      "Scoring limit reached. No more stories are scored now.",
    );
  }
  if (candidates.length === 0) return report;

  // 3a. Batch mode: one batch for all candidates.
  if (batchMode) {
    const entries: BatchEntry[] = candidates.map((c) => ({
      customId: customIdFor(c),
      storyId: c.storyId,
      itemId: c.itemId,
    }));
    try {
      const providerBatchId = await provider.submitBatch(
        candidates.map((c, i) => ({ customId: entries[i]!.customId, request: requestFor(c) })),
      );
      await store.saveBatch({ providerBatchId, entries, ...meta });
      report.submitted = candidates.length;
      logger.info({ providerBatchId, stories: candidates.length }, "Scoring batch submitted");
    } catch (error) {
      report.stopReason = "provider_errors";
      logger.error({ err: error }, "Cannot submit the scoring batch");
    }
    return report;
  }

  // 3b. Sync mode: one call per story. Check the real spend before each call.
  let errorsInRow = 0;
  for (const candidate of candidates) {
    if (spentDay + estimate > options.dailyLimitUsd) {
      report.stopReason = "daily_budget";
      break;
    }
    if (spentMonth + estimate > options.monthlyLimitUsd) {
      report.stopReason = "monthly_budget";
      break;
    }
    let response: LlmResponse;
    try {
      response = await provider.complete(requestFor(candidate));
    } catch (error) {
      report.failed++;
      errorsInRow++;
      logger.error({ err: error, storyId: candidate.storyId }, "Scoring request failed");
      if (errorsInRow >= MAX_CONSECUTIVE_ERRORS) {
        report.stopReason = "provider_errors";
        break;
      }
      continue;
    }
    errorsInRow = 0;
    const cost = costUsd(response.usage, options.pricing, false);
    spentDay += cost;
    spentMonth += cost;
    await handleAnswer(candidate, response, false, meta);
  }
  return report;
}
