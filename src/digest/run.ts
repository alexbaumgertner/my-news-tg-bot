import type { Logger } from "pino";
import { composeItems, type ComposedItem } from "../llm/compose.js";
import type { ComposeStory, DigestLanguage } from "../llm/compose-schema.js";
import type { Pricing } from "../llm/pricing.js";
import type { LlmProvider } from "../llm/provider.js";
import type { UsageStore } from "../llm/score-store.js";
import type { DigestKind, RankedStory } from "../pipeline/rank.js";
import type { Profile } from "../profile.js";
import { formatDigest, formatEmptyDigest, safeUrl } from "./format.js";

/** Sends one Telegram HTML message and returns its message id. Tests use a fake. */
export interface MessageSender {
  send(chatId: number, html: string): Promise<number>;
}

/** What is saved for one story of a digest. */
export interface DigestItemRecord {
  storyId: number;
  headline: string;
  summary: string;
  whyMe: string;
  url: string;
}

/** Everything that a digest run reads and writes in the database. Tests may fake it. */
export interface DigestStore {
  /** The digest of this slot and day, if any. `sentAt` is null for a digest that failed to send. */
  findDigest(kind: DigestKind, date: string): Promise<{ id: number; sentAt: Date | null } | null>;
  /** Rank the stories for this slot. Stories of sent digests are left out. */
  rank(kind: DigestKind, now: Date): Promise<RankedStory[]>;
  loadComposeStories(ranked: RankedStory[], maxChars: number): Promise<ComposeStory[]>;
  /** Items collected since `since` that are not in the shown stories, and their sources. */
  countFilteredOut(
    since: Date,
    shownStoryIds: number[],
  ): Promise<{ items: number; sources: number }>;
  /** Save the digest as not sent. It replaces an earlier digest of the slot that was not sent. */
  createDigest(digest: {
    kind: DigestKind;
    date: string;
    language: DigestLanguage;
    items: DigestItemRecord[];
  }): Promise<number>;
  /** Mark the digest as sent. Its stories now count as already sent. */
  markSent(digestId: number, messageIds: number[], sentAt: Date): Promise<void>;
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

export type DigestStatus = "sent" | "already_sent" | "dry_run";

export interface DigestResult {
  status: DigestStatus;
  /** Stories in the digest. 0 for a quiet day. */
  stories: number;
  messages: number;
  digestId: number | null;
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
    if (existing) logger.warn({ kind, date }, "An earlier send of this slot failed. Retrying.");
  }

  const ranked = await store.rank(kind, now);
  logger.info({ kind, ranked: ranked.length }, "Ranking finished");

  let messages: string[];
  let records: DigestItemRecord[] = [];
  const since = new Date(now.getTime() - options.windowHours * 3_600_000);
  const base = { kind, language, profile: options.profile, now, timeZone: options.timeZone };

  if (ranked.length === 0) {
    // A quiet day. Say so and never pad.
    const filteredOut = await store.countFilteredOut(since, []);
    messages = [formatEmptyDigest({ ...base, filteredOut })];
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
    // Without a composed item the digest is not quiet: it is broken. Fail, do not send "nothing".
    // The degraded digest is a separate issue (#22).
    const usable: ComposedItem[] = report.items.filter((item) => safeUrl(item.url) !== null);
    if (usable.length === 0) {
      throw new Error(
        `No story could be composed (${ranked.length} ranked, stop reason: ${report.stopReason ?? "none"})`,
      );
    }
    const filteredOut = await store.countFilteredOut(
      since,
      usable.map((item) => item.storyId),
    );
    const formatted = formatDigest({ ...base, items: usable, filteredOut });
    messages = formatted.messages;
    records = formatted.shown.map((item) => ({
      storyId: item.storyId,
      headline: item.headline,
      summary: item.summary,
      whyMe: item.whyMe,
      url: item.url,
    }));
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
    };
  }

  const digestId = await store.createDigest({ kind, date, language, items: records });
  const messageIds: number[] = [];
  try {
    for (const message of messages) {
      messageIds.push(await options.sender.send(options.chatId, message));
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
    throw new Error(`Telegram send failed: ${errorMessage(error)}`, { cause: error });
  }
  await store.markSent(digestId, messageIds, new Date());
  logger.info(
    { kind, date, digestId, stories: records.length, messages: messageIds.length },
    "Digest sent",
  );
  return { status: "sent", stories: records.length, messages: messages.length, digestId };
}
