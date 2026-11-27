import type { InlineKeyboardMarkup } from "grammy/types";
import type { Logger } from "pino";
import { feedbackKeyboard } from "../feedback/callback.js";
import { composeItems, type ComposedItem } from "../llm/compose.js";
import type { ComposeStory, DigestLanguage } from "../llm/compose-schema.js";
import type { Pricing } from "../llm/pricing.js";
import type { LlmProvider } from "../llm/provider.js";
import type { UsageStore } from "../llm/score-store.js";
import type { DigestKind, RankedStory } from "../pipeline/rank.js";
import type { Profile } from "../profile.js";
import { formatDegradedDigest, formatDigest, formatEmptyDigest, safeUrl } from "./format.js";

/** Sends one Telegram HTML message and returns its message id. Tests use a fake. */
export interface MessageSender {
  send(chatId: number, html: string, replyMarkup?: InlineKeyboardMarkup): Promise<number>;
}

/** What is saved for one story of a digest. */
export interface DigestItemRecord {
  storyId: number;
  headline: string;
  summary: string;
  whyMe: string;
  url: string;
}

/** Counts of the last day, for the daily log line. */
export interface DaySummary {
  /** Active sources without a failure streak, and with one. */
  sourcesOk: number;
  sourcesFailed: number;
  itemsCollected: number;
  /** Stories that passed the pre-filter. */
  storiesPassed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Everything that a digest run reads and writes in the database. Tests may fake it. */
export interface DigestStore {
  /** The digest of this slot and day, if any. `sentAt` is null for a digest that failed to send. */
  findDigest(kind: DigestKind, date: string): Promise<{ id: number; sentAt: Date | null } | null>;
  /** Rank the stories for this slot. Stories of sent digests are left out. */
  rank(kind: DigestKind, now: Date): Promise<RankedStory[]>;
  /**
   * Rank for a degraded digest: the same rules and limits, but a story needs no LLM score.
   * Stories of sent digests are left out.
   */
  rankDegraded(kind: DigestKind, now: Date): Promise<RankedStory[]>;
  /** Counts since `since`, for the daily log line. */
  daySummary(since: Date): Promise<DaySummary>;
  loadComposeStories(ranked: RankedStory[], maxChars: number): Promise<ComposeStory[]>;
  /** Items collected since `since` that are not in the shown stories, and their sources. */
  countFilteredOut(
    since: Date,
    shownStoryIds: number[],
  ): Promise<{ items: number; sources: number }>;
  /**
   * Take the slot and save the digest as not sent. Atomic. Returns null when the slot is
   * sent, or when another run holds an active claim. Takes over a failed digest, or a claim
   * whose lease expired (a crashed run). Never replaces an active claim.
   */
  claimDigest(
    digest: {
      kind: DigestKind;
      date: string;
      language: DigestLanguage;
      items: DigestItemRecord[];
    },
    now: Date,
  ): Promise<DigestClaim | null>;
  /**
   * Mark the digest as sent. Its stories now count as already sent.
   * Throws when the claim was lost, so that a double send is never reported as success.
   */
  markSent(claim: DigestClaim, messageIds: number[], sentAt: Date): Promise<void>;
  /** Give the claim up after a failed send, so that a retry can take the slot at once. */
  releaseClaim(claim: DigestClaim): Promise<void>;
}

/** Proof that a run owns the slot. */
export interface DigestClaim {
  digestId: number;
  token: string;
}

export interface DigestRunOptions {
  store: DigestStore;
  sender: MessageSender;
  /** Receives the usage rows of the composer. Shared with scoring. */
  usageStore: UsageStore;
  /** Null when `ANTHROPIC_API_KEY` is not set. */
  provider: LlmProvider | null;
  logger: Logger;
  profile: Profile;
  kind: DigestKind;
  language: DigestLanguage;
  timeZone: string;
  chatId: number;
  dryRun: boolean;
  /** Prints the messages of a dry run. */
  print: (text: string) => void;
  now?: () => Date;
  /** Hours of items that count for the footer. Must match the ranking window. */
  windowHours: number;
  model: string;
  maxChars: number;
  maxOutputTokens: number;
  pricing: Pricing;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

export type DigestStatus = "sent" | "already_sent" | "in_progress" | "dry_run";

export interface DigestResult {
  status: DigestStatus;
  /** Stories in the digest. 0 for a quiet day. */
  stories: number;
  messages: number;
  digestId: number | null;
  /** True when the digest has headlines and links only, because the LLM was not available. */
  degraded?: boolean;
}

/** The local calendar date ("YYYY-MM-DD") of `now` in a time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Log one line with the counts of the last day. A failure here never fails the digest. */
async function logDaySummary(options: DigestRunOptions, since: Date): Promise<void> {
  try {
    const day = await options.store.daySummary(since);
    options.logger.info(
      { kind: options.kind, ...day, costUsd: Number(day.costUsd.toFixed(4)) },
      `Daily summary: sources ok ${day.sourcesOk}, failed ${day.sourcesFailed}; items collected ${day.itemsCollected}; stories passed ${day.storiesPassed}; tokens in ${day.inputTokens}, out ${day.outputTokens}; cost $${day.costUsd.toFixed(4)}`,
    );
  } catch (error) {
    options.logger.warn({ error: errorMessage(error) }, "Could not build the daily summary");
  }
}

/**
 * Build one digest and send it. Throws when the digest cannot be built or sent. A failed
 * send leaves the digest as not sent, so its stories stay available for the next run.
 * Dry run: print the messages, write nothing.
 */
export async function runDigest(options: DigestRunOptions): Promise<DigestResult> {
  const { store, logger, kind, language, dryRun } = options;
  const now = (options.now ?? (() => new Date()))();
  const date = localDate(now, options.timeZone);

  if (!dryRun) {
    const existing = await store.findDigest(kind, date);
    if (existing?.sentAt) {
      logger.info(
        { kind, date, digestId: existing.id },
        "This slot was already sent. Nothing to do.",
      );
      return { status: "already_sent", stories: 0, messages: 0, digestId: existing.id };
    }
    if (existing) logger.warn({ kind, date }, "An earlier run of this slot did not send. Trying.");
  }

  const ranked = await store.rank(kind, now);
  logger.info({ kind, ranked: ranked.length }, "Ranking finished");

  let messages: string[] = [];
  /** For each message, the positions of the items that get feedback buttons. */
  let messageItems: number[][] = [];
  let records: DigestItemRecord[] = [];
  let degraded = false;
  const since = new Date(now.getTime() - options.windowHours * 3_600_000);
  const base = { kind, language, profile: options.profile, now, timeZone: options.timeZone };

  /** Headlines and links of the given stories. No LLM call. */
  const buildDegraded = async (list: RankedStory[]) => {
    const stories = await store.loadComposeStories(list, 0);
    const probe = formatDegradedDigest({ ...base, stories });
    const filteredOut = await store.countFilteredOut(
      since,
      probe.shown.map((story) => story.storyId),
    );
    return formatDegradedDigest({ ...base, stories, filteredOut });
  };
  const useDegraded = (formatted: Awaited<ReturnType<typeof buildDegraded>>) => {
    degraded = true;
    messages = formatted.messages;
    messageItems = formatted.messageItems;
    records = formatted.shown.map((story) => ({
      storyId: story.storyId,
      headline: story.title,
      summary: "",
      whyMe: "",
      url: story.url,
    }));
  };

  if (ranked.length === 0) {
    // Nothing is scored. Stories that passed the pre-filter can still wait for a score,
    // because the LLM was unavailable or over budget. Send them as a degraded digest.
    const fallback = await store.rankDegraded(kind, now);
    const formatted = fallback.length > 0 ? await buildDegraded(fallback) : null;
    if (formatted && formatted.shown.length > 0) {
      logger.warn(
        { stories: formatted.shown.length },
        "No scored story. Sending a degraded digest.",
      );
      useDegraded(formatted);
    } else {
      // A quiet day. Say so and never pad.
      const filteredOut = await store.countFilteredOut(since, []);
      messages = [formatEmptyDigest({ ...base, filteredOut })];
    }
  } else {
    const stories = await store.loadComposeStories(ranked, options.maxChars);
    const report = await composeItems(stories, {
      store: options.usageStore,
      provider: options.provider,
      runKey: `${kind}-${date}`,
      dailyLimitUsd: options.dailyLimitUsd,
      monthlyLimitUsd: options.monthlyLimitUsd,
      now: () => now,
      logger,
      profile: options.profile,
      model: options.model,
      language,
      maxChars: options.maxChars,
      maxOutputTokens: options.maxOutputTokens,
      pricing: options.pricing,
    });
    logger.info(
      {
        composed: report.items.length,
        skipped: report.skipped,
        uncomposed: report.uncomposed.length,
        stopReason: report.stopReason,
        costUsd: report.costUsd,
      },
      "Composing finished",
    );
    const usable: ComposedItem[] = report.items.filter((item) => safeUrl(item.url) !== null);
    if (usable.length === 0) {
      // The LLM gave nothing: no key, over budget, or every call failed. Do not send "nothing".
      // Send the ranked stories as headlines and links.
      logger.warn(
        { ranked: ranked.length, stopReason: report.stopReason },
        "No story could be composed. Sending a degraded digest.",
      );
      const formatted = await buildDegraded(ranked);
      if (formatted.shown.length === 0) {
        throw new Error(
          `No story could be composed or listed (${ranked.length} ranked, stop reason: ${report.stopReason ?? "none"})`,
        );
      }
      useDegraded(formatted);
    } else {
      const filteredOut = await store.countFilteredOut(
        since,
        usable.map((item) => item.storyId),
      );
      const formatted = formatDigest({ ...base, items: usable, filteredOut });
      messages = formatted.messages;
      messageItems = formatted.messageItems;
      records = formatted.shown.map((item) => ({
        storyId: item.storyId,
        headline: item.headline,
        summary: item.summary,
        whyMe: item.whyMe,
        url: item.url,
      }));
    }
  }

  if (dryRun) {
    messages.forEach((message, i) => {
      options.print(`--- message ${i + 1} of ${messages.length} ---\n${message}`);
    });
    logger.info(
      { kind, stories: records.length, messages: messages.length },
      "Dry run. Nothing sent.",
    );
    return {
      status: "dry_run",
      stories: records.length,
      messages: messages.length,
      digestId: null,
      degraded,
    };
  }

  const claim = await store.claimDigest(
    { kind, date, language, items: records },
    (options.now ?? (() => new Date()))(),
  );
  if (!claim) {
    logger.warn({ kind, date }, "Another run holds this slot, or it was sent. Nothing sent.");
    return { status: "in_progress", stories: 0, messages: 0, digestId: null };
  }
  const digestId = claim.digestId;
  const messageIds: number[] = [];
  try {
    for (const [index, message] of messages.entries()) {
      // One row of buttons for each item in the message. A message without items has none.
      const positions = messageItems[index] ?? [];
      const keyboard = positions.length > 0 ? feedbackKeyboard(digestId, positions) : undefined;
      messageIds.push(await options.sender.send(options.chatId, message, keyboard));
    }
  } catch (error) {
    // Do not log the error object: it can carry request details.
    logger.error(
      {
        kind,
        date,
        digestId,
        sentMessages: messageIds.length,
        total: messages.length,
        error: errorMessage(error),
      },
      "Send failed. The digest stays unsent. Run the command again to retry.",
    );
    await store.releaseClaim(claim).catch((releaseError: unknown) => {
      // The lease expiry frees the slot later.
      logger.warn({ error: errorMessage(releaseError) }, "Could not release the claim");
    });
    throw new Error(`Telegram send failed: ${errorMessage(error)}`, { cause: error });
  }
  await store.markSent(claim, messageIds, new Date());
  logger.info(
    { kind, date, digestId, stories: records.length, messages: messageIds.length, degraded },
    "Digest sent",
  );
  await logDaySummary(options, since);
  return {
    status: "sent",
    stories: records.length,
    messages: messages.length,
    digestId,
    degraded,
  };
}
