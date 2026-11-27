import { readFileSync } from "node:fs";
import { z } from "zod";
import { costUsd, estimateCostUsd, type Pricing } from "../llm/pricing.js";
import type { LlmProvider } from "../llm/provider.js";
import { buildScorePrompt, parseScore, renderStory } from "../llm/score-schema.js";
import type { Profile } from "../profile.js";

const goldenLineSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  label: z.enum(["keep", "drop"]),
});

export type GoldenEvalItem = z.infer<typeof goldenLineSchema>;

/** Read `tests/golden/items.jsonl`. Throw with the line number on a bad line. */
export function loadGoldenItems(path: string): GoldenEvalItem[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const result: GoldenEvalItem[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const parsed = goldenLineSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Invalid golden item at line ${index + 1}: ${parsed.error.message}`);
    }
    result.push(parsed.data);
  });
  return result;
}

export interface KeepMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  /** Null when there are no predicted `keep`. */
  precision: number | null;
  /** Null when there are no expected `keep`. */
  recall: number | null;
}

/** Precision and recall of `keep`. */
export function keepMetrics(
  pairs: readonly { expected: "keep" | "drop"; predicted: "keep" | "drop" }[],
): KeepMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { expected, predicted } of pairs) {
    if (predicted === "keep") {
      if (expected === "keep") tp++;
      else fp++;
    } else if (expected === "keep") fn++;
    else tn++;
  }
  return {
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

export interface GoldenEvalOptions {
  items: readonly GoldenEvalItem[];
  provider: LlmProvider;
  profile: Profile;
  model: string;
  maxChars: number;
  maxOutputTokens: number;
  pricing: Pricing;
  /** A story with relevance at or above this value counts as `keep`. */
  keepThreshold: number;
  /** The run stops before the next call when the cost would pass this limit. */
  maxCostUsd: number;
}

export interface GoldenEvalReport {
  metrics: KeepMetrics;
  evaluated: number;
  /** Items with invalid output. They count as `drop`, so a bad prompt lowers recall. */
  invalid: number;
  /** Items not sent because of `maxCostUsd`. */
  skippedForCost: number;
  costUsd: number;
}

/** Score every golden item with the real prompt and compare `keep` with the labels. */
export async function evaluateGolden(options: GoldenEvalOptions): Promise<GoldenEvalReport> {
  const prompt = buildScorePrompt(options.profile);
  const topicIds = new Set(options.profile.topics.map((t) => t.id));
  const estimate = estimateCostUsd(
    options.pricing,
    {
      systemChars: prompt.system.length,
      userChars: options.maxChars + 500,
      maxOutputTokens: options.maxOutputTokens,
    },
    false,
  );
  const pairs: { expected: "keep" | "drop"; predicted: "keep" | "drop" }[] = [];
  let invalid = 0;
  let skippedForCost = 0;
  let cost = 0;
  for (const item of options.items) {
    if (cost + estimate > options.maxCostUsd) {
      skippedForCost++;
      continue;
    }
    const response = await options.provider.complete({
      model: options.model,
      system: prompt.system,
      user: renderStory(item.title, item.snippet, options.maxChars),
      maxTokens: options.maxOutputTokens,
    });
    cost += costUsd(response.usage, options.pricing, false);
    const parsed = parseScore(response.text, topicIds);
    if (!parsed.ok) invalid++;
    const keep = parsed.ok && parsed.score.relevance >= options.keepThreshold;
    pairs.push({ expected: item.label, predicted: keep ? "keep" : "drop" });
  }
  return {
    metrics: keepMetrics(pairs),
    evaluated: pairs.length,
    invalid,
    skippedForCost,
    costUsd: cost,
  };
}
