import type { Logger } from "pino";
import type { Profile } from "../profile.js";
import {
  buildComposePrompt,
  parseCompose,
  renderComposeStory,
  type ComposeStory,
  type ComposedText,
  type DigestLanguage,
} from "./compose-schema.js";
import { costUsd, estimateCostUsd, type Pricing } from "./pricing.js";
import type { LlmProvider, LlmUsage } from "./provider.js";
import { startOfUtcDay, startOfUtcMonth } from "./score.js";
import type { ScorePrompt } from "./score-schema.js";
import type { UsageStore } from "./score-store.js";

export interface ComposedItem extends ComposeStory {
  headline: string;
  summary: string;
  whyMe: string;
}

export type ComposeStopReason = "no_api_key" | "daily_budget" | "monthly_budget";

export interface ComposeOptions {
  /** The shared usage store. Scoring and composing count against the same limits. */
  store: UsageStore;
  /** Null when `ANTHROPIC_API_KEY` is not set. */
  provider: LlmProvider | null;
  /** Identifies one digest run. It makes the usage rows idempotent: a replay adds no row. */
  runKey: string;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  now?: () => Date;
  logger: Logger;
  profile: Profile;
  model: string;
  language: DigestLanguage;
  maxChars: number;
  maxOutputTokens: number;
  pricing: Pricing;
  /** Test hook. Default: the prompt file. */
  prompt?: ScorePrompt;
}

export interface ComposeReport {
  /** Composed items, in the order of the input. A failed story is not in the list. */
  items: ComposedItem[];
  /** Stories that failed. They are logged and skipped. */
  skipped: number;
  /** Stories without a composed text, because the run stopped. The caller must not show them as composed. */
  uncomposed: ComposeStory[];
  stopReason: ComposeStopReason | null;
  usage: LlmUsage;
  costUsd: number;
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Write the text of each story with one call per story. Invalid output and provider errors are
 * logged and the story is skipped. The digest never pads or retries without a limit.
 */
export async function composeItems(
  stories: ComposeStory[],
  options: ComposeOptions,
): Promise<ComposeReport> {
  const { provider, logger, store } = options;
  const prompt = options.prompt ?? buildComposePrompt(options.profile);
  const report: ComposeReport = {
    items: [],
    skipped: 0,
    uncomposed: [],
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
  if (!provider) {
    logger.error("ANTHROPIC_API_KEY is not set. Composing is skipped.");
    report.stopReason = "no_api_key";
    report.uncomposed = [...stories];
    return report;
  }
  // The estimate reserves the uncached worst case, as scoring does.
  const estimate = estimateCostUsd(
    options.pricing,
    {
      systemChars: prompt.system.length,
      userChars: options.maxChars + 1000,
      maxOutputTokens: options.maxOutputTokens,
    },
    false,
  );
  const clock = (options.now ?? (() => new Date()))();
  let spentDay = await store.spentSince(startOfUtcDay(clock));
  let spentMonth = await store.spentSince(startOfUtcMonth(clock));
  for (const [index, story] of stories.entries()) {
    if (spentDay + estimate > options.dailyLimitUsd) report.stopReason = "daily_budget";
    else if (spentMonth + estimate > options.monthlyLimitUsd) report.stopReason = "monthly_budget";
    if (report.stopReason) {
      report.uncomposed = stories.slice(index);
      logger.warn(
        { limit: report.stopReason, spentDay, spentMonth, uncomposed: report.uncomposed.length },
        "Composing budget reached. The remaining stories have no composed text.",
      );
      break;
    }
    let text: ComposedText;
    try {
      const response = await provider.complete({
        model: options.model,
        system: prompt.system,
        user: renderComposeStory(story, options.language, options.maxChars),
        maxTokens: options.maxOutputTokens,
      });
      // Record the usage before the validation, so an invalid answer is paid for in the books.
      const cost = costUsd(response.usage, options.pricing, false);
      const recorded = await store.recordUsage(
        options.model,
        response.usage,
        cost,
        `compose:${options.runKey}:s${story.storyId}`,
        "compose",
      );
      if (recorded) {
        report.usage = addUsage(report.usage, response.usage);
        report.costUsd += cost;
        spentDay += cost;
        spentMonth += cost;
      }
      const parsed = parseCompose(response.text);
      if (!parsed.ok) {
        report.skipped++;
        logger.warn(
          { storyId: story.storyId, error: parsed.error },
          "Invalid compose output. The story is skipped.",
        );
        continue;
      }
      text = parsed.text;
    } catch (error) {
      report.skipped++;
      logger.error({ err: error, storyId: story.storyId }, "Compose request failed");
      continue;
    }
    report.items.push({
      ...story,
      headline: text.headline,
      summary: text.summary,
      whyMe: text.why_me,
    });
  }
  return report;
}
