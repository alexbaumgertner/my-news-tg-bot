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
import { costUsd, type Pricing } from "./pricing.js";
import type { LlmProvider, LlmUsage } from "./provider.js";
import type { ScorePrompt } from "./score-schema.js";

export interface ComposedItem extends ComposeStory {
  headline: string;
  summary: string;
  whyMe: string;
}

export interface ComposeOptions {
  provider: LlmProvider;
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
  const { provider, logger } = options;
  const prompt = options.prompt ?? buildComposePrompt(options.profile);
  const report: ComposeReport = {
    items: [],
    skipped: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
  for (const story of stories) {
    let text: ComposedText;
    try {
      const response = await provider.complete({
        model: options.model,
        system: prompt.system,
        user: renderComposeStory(story, options.language, options.maxChars),
        maxTokens: options.maxOutputTokens,
      });
      report.usage = addUsage(report.usage, response.usage);
      report.costUsd += costUsd(response.usage, options.pricing, false);
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
