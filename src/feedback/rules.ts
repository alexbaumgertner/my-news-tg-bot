/** A vote on a digest item. */
export type Vote = "up" | "down";

/** Step and bounds of the adjustments. Values come from `FEEDBACK_*` in `.env`. */
export interface FeedbackConfig {
  /** Each vote moves a multiplier by this fraction of 1. Default: 0.05. */
  step: number;
  topicMin: number;
  topicMax: number;
  sourceMin: number;
  sourceMax: number;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  step: 0.05,
  topicMin: 0.5,
  topicMax: 1.5,
  sourceMin: 0.5,
  sourceMax: 1.5,
};

/** The vote that stays after the user presses `pressed` while `current` is stored. Null: none. */
export function nextVote(current: Vote | null, pressed: Vote): Vote | null {
  return current === pressed ? null : pressed;
}

/** A stored vote with the topics and the source that were copied at vote time. */
export interface VoteRecord {
  kind: Vote;
  topics: string[];
  sourceId: number | null;
}

export interface Adjustments {
  /** Multiplier of the weight of a topic. A topic that is not here has 1. */
  topics: ReadonlyMap<string, number>;
  /** Multiplier of the trust of a source (by source id). A source that is not here has 1. */
  sources: ReadonlyMap<number, number>;
}

export const NO_ADJUSTMENTS: Adjustments = { topics: new Map(), sources: new Map() };

/**
 * The multiplier for a net vote count (up minus down): 1 + step × net, inside the bounds.
 * It is rounded to 4 decimals, so the same votes always give the same number.
 */
export function multiplierFor(net: number, step: number, min: number, max: number): number {
  const value = Math.min(max, Math.max(min, 1 + step * net));
  return Math.round(value * 10_000) / 10_000;
}

/** Keep a stored multiplier inside the bounds. This holds even when the config changed. */
export function clampMultiplier(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute the adjustments from all votes. Pure: the order of the votes does not matter, and a
 * changed or deleted vote is a new computation, not a drift. A multiplier of 1 is left out.
 */
export function computeAdjustments(
  votes: readonly VoteRecord[],
  config: FeedbackConfig,
): Adjustments {
  const topicNet = new Map<string, number>();
  const sourceNet = new Map<number, number>();
  for (const vote of votes) {
    const delta = vote.kind === "up" ? 1 : -1;
    // A topic that a story lists twice counts once.
    for (const topic of new Set(vote.topics)) {
      topicNet.set(topic, (topicNet.get(topic) ?? 0) + delta);
    }
    if (vote.sourceId !== null) {
      sourceNet.set(vote.sourceId, (sourceNet.get(vote.sourceId) ?? 0) + delta);
    }
  }
  const topics = new Map<string, number>();
  for (const [topic, net] of topicNet) {
    const value = multiplierFor(net, config.step, config.topicMin, config.topicMax);
    if (value !== 1) topics.set(topic, value);
  }
  const sources = new Map<number, number>();
  for (const [id, net] of sourceNet) {
    const value = multiplierFor(net, config.step, config.sourceMin, config.sourceMax);
    if (value !== 1) sources.set(id, value);
  }
  return { topics, sources };
}
