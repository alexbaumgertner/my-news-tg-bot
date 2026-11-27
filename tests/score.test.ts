import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { evaluateGolden, keepMetrics } from "../src/golden/eval.js";
import { AnthropicProvider, readLimitedText } from "../src/llm/anthropic.js";
import { costUsd, estimateCostUsd, type Pricing } from "../src/llm/pricing.js";
import { FakeProvider, type LlmUsage } from "../src/llm/provider.js";
import { runScoring, type ScoringOptions } from "../src/llm/score.js";
import { buildScorePrompt, parseScore, renderStory } from "../src/llm/score-schema.js";
import type {
  BatchEntry,
  Candidate,
  PendingBatch,
  ScoreMeta,
  ScoringStore,
} from "../src/llm/score-store.js";
import { parseEnv } from "../src/config.js";
import { profileSchema } from "../src/profile.js";

const profile = profileSchema.parse({
  version: 1,
  about_me: "A software engineer.",
  hard_exclusions: { description: "No gossip.", keywords: ["gossip"] },
  safety_exception: { description: "Safety in Antalya.", keywords: ["Antalya"] },
  topics: [
    {
      id: "ai",
      title: "AI",
      weight: 1,
      description: "agents",
      keywords: ["a1", "a2", "a3", "a4", "a5"],
    },
    {
      id: "medicine",
      title: "Medicine",
      weight: 0.8,
      description: "trials",
      keywords: ["m1", "m2", "m3", "m4", "m5"],
    },
  ],
});

const pricing: Pricing = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
  batchFactor: 0.5,
};

const validOutput = {
  topics: ["ai"],
  relevance: 8,
  impact: "work",
  why_me: "It changes how you use agents.",
  novelty: 0.9,
  confidence: 0.8,
  is_russia_domestic: false,
  study_type: null,
};
const validJson = JSON.stringify(validOutput);

const logger = pino({ level: "silent" });

/** In-memory store. `candidates` are stories that already passed the pre-filter. */
class MemoryStore implements ScoringStore {
  scores = new Map<number, { itemId: number; relevance: number }>();
  failed = new Map<number, number>();
  usage: { cost: number; at: Date }[] = [];
  batches: (PendingBatch & { status: "pending" | "ended" })[] = [];

  constructor(
    readonly candidates: Candidate[],
    private readonly now: Date,
  ) {}

  async spentSince(since: Date) {
    return this.usage.filter((u) => u.at >= since).reduce((sum, u) => sum + u.cost, 0);
  }
  async scoredCallsSince(since: Date) {
    return this.usage.filter((u) => u.at >= since).length;
  }
  async pendingBatches() {
    return this.batches.filter((b) => b.status === "pending");
  }
  async findCandidates(limit: number) {
    return this.candidates
      .filter((c) => this.scores.get(c.storyId)?.itemId !== c.itemId)
      .filter((c) => this.failed.get(c.storyId) !== c.itemId)
      .slice(0, limit);
  }
  async saveScore(candidate: Pick<Candidate, "storyId" | "itemId">, score: { relevance: number }) {
    this.scores.set(candidate.storyId, { itemId: candidate.itemId, relevance: score.relevance });
  }
  async markFailed(candidate: Pick<Candidate, "storyId" | "itemId">) {
    this.failed.set(candidate.storyId, candidate.itemId);
  }
  async recordUsage(_model: string, _usage: LlmUsage, cost: number) {
    this.usage.push({ cost, at: this.now });
  }
  async saveBatch(batch: { providerBatchId: string; entries: BatchEntry[] } & ScoreMeta) {
    this.batches.push({ id: this.batches.length + 1, status: "pending", ...batch });
  }
  async endBatch(id: number) {
    this.batches.find((b) => b.id === id)!.status = "ended";
  }
}

const NOW = new Date("2026-06-10T12:00:00Z");

function stories(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    storyId: i + 1,
    itemId: 100 + i + 1,
    title: `Story ${i + 1}`,
    text: "Body",
  }));
}

function options(
  store: MemoryStore,
  provider: FakeProvider | null,
  extra: Partial<ScoringOptions> = {},
) {
  return {
    store,
    provider,
    logger,
    profile,
    model: "test-model",
    mode: "sync",
    dailyCap: 100,
    dailyLimitUsd: 1,
    monthlyLimitUsd: 10,
    maxChars: 1500,
    maxOutputTokens: 500,
    pricing,
    now: () => NOW,
    ...extra,
  } satisfies ScoringOptions;
}

describe("parseScore", () => {
  const ids = new Set(["ai", "medicine"]);

  it("accepts valid output, also in a code fence", () => {
    expect(parseScore(validJson, ids).ok).toBe(true);
    expect(parseScore("```json\n" + validJson + "\n```", ids).ok).toBe(true);
  });

  it.each([
    ["text that is not JSON", "Sure! Here is the score."],
    ["relevance out of range", JSON.stringify({ ...validOutput, relevance: 11 })],
    ["relevance that is not an integer", JSON.stringify({ ...validOutput, relevance: 7.5 })],
    ["a missing key", JSON.stringify({ ...validOutput, why_me: undefined })],
    ["an unknown key", JSON.stringify({ ...validOutput, extra: 1 })],
    ["an unknown impact", JSON.stringify({ ...validOutput, impact: "money" })],
    ["an unknown topic id", JSON.stringify({ ...validOutput, topics: ["cooking"] })],
    ["a bad study type", JSON.stringify({ ...validOutput, study_type: "magic" })],
  ])("rejects %s", (_name, text) => {
    expect(parseScore(text, ids).ok).toBe(false);
  });
});

describe("prompt", () => {
  it("puts the profile and its topic ids in the system block", () => {
    const prompt = buildScorePrompt(profile);
    expect(prompt.system).toContain("id: ai");
    expect(prompt.system).toContain("id: medicine");
    expect(prompt.version).toMatch(/^score-[0-9a-f]{8}$/);
  });

  it("cuts the story text to the character limit", () => {
    const user = renderStory("T", "Z".repeat(5000), 1500);
    expect(user.match(/Z/g)).toHaveLength(1500);
  });
});

describe("pricing", () => {
  const usage: LlmUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };

  it("computes the cost and halves it for a batch", () => {
    expect(costUsd(usage, pricing, false)).toBeCloseTo(7.35);
    expect(costUsd(usage, pricing, true)).toBeCloseTo(3.675);
  });

  it("estimates more than it costs for a normal story", () => {
    const estimate = estimateCostUsd(
      pricing,
      { systemChars: 3000, userChars: 2000, maxOutputTokens: 500 },
      false,
    );
    const real = costUsd(
      { inputTokens: 700, outputTokens: 150, cacheReadTokens: 1000, cacheWriteTokens: 0 },
      pricing,
      false,
    );
    expect(estimate).toBeGreaterThan(real);
  });
});

describe("runScoring (sync)", () => {
  it("stores valid output and records usage", async () => {
    const store = new MemoryStore(stories(3), NOW);
    const provider = new FakeProvider(() => validJson);
    const report = await runScoring(options(store, provider));
    expect(report).toMatchObject({ scored: 3, invalid: 0, stopReason: null });
    expect(store.scores.size).toBe(3);
    expect(store.usage).toHaveLength(3);
    // 1000 input and 100 output tokens at the test prices.
    expect(store.usage[0]!.cost).toBeCloseTo(0.0015);
  });

  it("sends the cached system block, the cut text and the configured model", async () => {
    const store = new MemoryStore([{ ...stories(1)[0]!, text: "Z".repeat(3000) }], NOW);
    const provider = new FakeProvider(() => validJson);
    await runScoring(options(store, provider, { maxChars: 1500 }));
    const request = provider.requests[0]!;
    expect(request.model).toBe("test-model");
    expect(request.system).toContain("id: ai");
    expect(request.user.match(/Z/g)).toHaveLength(1500);
  });

  it("skips invalid output, logs it and does not retry the same item", async () => {
    const store = new MemoryStore(stories(2), NOW);
    const provider = new FakeProvider((r) => (r.user.includes("Story 1") ? "not json" : validJson));
    const report = await runScoring(options(store, provider));
    expect(report).toMatchObject({ scored: 1, invalid: 1 });
    expect(store.scores.has(1)).toBe(false);
    // The tokens were spent, so the usage is recorded.
    expect(store.usage).toHaveLength(2);
    const again = await runScoring(options(store, provider));
    expect(again.scored + again.invalid).toBe(0);
    expect(provider.requests).toHaveLength(2);
  });

  it("scores a story again only when its representative changed", async () => {
    const store = new MemoryStore(stories(1), NOW);
    const provider = new FakeProvider(() => validJson);
    await runScoring(options(store, provider));
    await runScoring(options(store, provider));
    expect(provider.requests).toHaveLength(1);
    store.candidates[0] = { ...store.candidates[0]!, itemId: 999 };
    await runScoring(options(store, provider));
    expect(provider.requests).toHaveLength(2);
    expect(store.scores.get(1)!.itemId).toBe(999);
  });

  it("stops at the daily cap", async () => {
    const store = new MemoryStore(stories(10), NOW);
    const provider = new FakeProvider(() => validJson);
    const report = await runScoring(options(store, provider, { dailyCap: 4 }));
    expect(report.scored).toBe(4);
    expect(report.stopReason).toBe("daily_cap");
    // A second run on the same day scores nothing.
    const again = await runScoring(options(store, provider, { dailyCap: 4 }));
    expect(again.scored).toBe(0);
    expect(provider.requests).toHaveLength(4);
  });

  it("stops at the daily budget", async () => {
    const store = new MemoryStore(stories(10), NOW);
    const provider = new FakeProvider(() => validJson);
    // One story costs 0.0015 in the fake. The estimate is higher, so only a few fit.
    const report = await runScoring(options(store, provider, { dailyLimitUsd: 0.01 }));
    expect(report.stopReason).toBe("daily_budget");
    expect(report.scored).toBeLessThan(10);
    expect(store.usage.reduce((sum, u) => sum + u.cost, 0)).toBeLessThanOrEqual(0.01);
  });

  it("stops at the monthly budget", async () => {
    const store = new MemoryStore(stories(5), NOW);
    store.usage.push({ cost: 4.999, at: new Date("2026-06-02T00:00:00Z") });
    const provider = new FakeProvider(() => validJson);
    const report = await runScoring(options(store, provider, { monthlyLimitUsd: 5 }));
    expect(report.scored).toBe(0);
    expect(report.stopReason).toBe("monthly_budget");
    expect(provider.requests).toHaveLength(0);
  });

  it("does nothing and does not throw when the key is missing", async () => {
    const store = new MemoryStore(stories(2), NOW);
    const report = await runScoring(options(store, null));
    expect(report).toMatchObject({ status: "no_api_key", scored: 0 });
    expect(store.usage).toHaveLength(0);
  });

  it("stops after repeated provider errors", async () => {
    const store = new MemoryStore(stories(10), NOW);
    const provider = new FakeProvider(() => new Error("down"));
    const report = await runScoring(options(store, provider));
    expect(report.stopReason).toBe("provider_errors");
    expect(provider.requests).toHaveLength(3);
  });
});

describe("runScoring (batch)", () => {
  it("submits a batch, then stores the results in a later run", async () => {
    const store = new MemoryStore(stories(3), NOW);
    const provider = new FakeProvider(() => validJson);
    provider.batchEnded = false;
    const first = await runScoring(options(store, provider, { mode: "batch" }));
    expect(first.submitted).toBe(3);
    expect(store.scores.size).toBe(0);
    expect(provider.requests).toHaveLength(0);

    // The batch is still running: nothing is sent twice.
    const waiting = await runScoring(options(store, provider, { mode: "batch" }));
    expect(waiting.submitted).toBe(0);
    expect(provider.batches.size).toBe(1);

    provider.batchEnded = true;
    const second = await runScoring(options(store, provider, { mode: "batch" }));
    expect(second).toMatchObject({ batchesCollected: 1, scored: 3, submitted: 0 });
    // Batch usage costs half of the normal price.
    expect(store.usage[0]!.cost).toBeCloseTo(0.00075);
  });

  it("counts the stories of a pending batch against the daily cap", async () => {
    const store = new MemoryStore(stories(10), NOW);
    const provider = new FakeProvider(() => validJson);
    provider.batchEnded = false;
    await runScoring(options(store, provider, { mode: "batch", dailyCap: 4 }));
    const second = await runScoring(options(store, provider, { mode: "batch", dailyCap: 6 }));
    expect(second.submitted).toBe(2);
  });

  it("skips invalid batch output", async () => {
    const store = new MemoryStore(stories(2), NOW);
    const provider = new FakeProvider((r) => (r.user.includes("Story 2") ? "{}" : validJson));
    await runScoring(options(store, provider, { mode: "batch" }));
    const report = await runScoring(options(store, provider, { mode: "batch" }));
    expect(report).toMatchObject({ scored: 1, invalid: 1 });
  });

  it("does not submit when the budget is used", async () => {
    const store = new MemoryStore(stories(3), NOW);
    const provider = new FakeProvider(() => validJson);
    const report = await runScoring(
      options(store, provider, { mode: "batch", dailyLimitUsd: 0.0001 }),
    );
    expect(report.submitted).toBe(0);
    expect(report.stopReason).toBe("daily_budget");
    expect(provider.batches.size).toBe(0);
  });
});

describe("AnthropicProvider", () => {
  const message = {
    content: [{ type: "text", text: validJson }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
  };

  it("sends the system block with cache control and reads the usage", async () => {
    let body: { system: Record<string, unknown>[]; max_tokens: number } | undefined;
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify(message), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "secret", fetchImpl });
    const response = await provider.complete({
      model: "m",
      system: "SYS",
      user: "U",
      maxTokens: 50,
    });
    expect(body!.system[0]).toMatchObject({ text: "SYS", cache_control: { type: "ephemeral" } });
    expect(body!.max_tokens).toBe(50);
    expect(headers["x-api-key"]).toBe("secret");
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    });
  });

  it("does not put the key in the error message", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "secret", fetchImpl });
    const error = await provider
      .complete({ model: "m", system: "S", user: "U", maxTokens: 5 })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain("400");
    expect((error as Error).message).not.toContain("secret");
  });

  it("reads batch results from the JSONL file", async () => {
    const line = (id: string, result: unknown) => JSON.stringify({ custom_id: id, result });
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/results")) {
        return new Response(
          [
            line("a", { type: "succeeded", message }),
            line("b", { type: "errored", error: {} }),
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "batch_1",
          processing_status: "ended",
          results_url: "https://api.anthropic.com/v1/messages/batches/batch_1/results",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });
    const status = await provider.getBatch("batch_1");
    expect(status.status).toBe("ended");
    if (status.status === "ended") {
      expect(status.results.map((r) => r.ok)).toEqual([true, false]);
    }
  });

  it("refuses a results URL on another host", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: "b",
          processing_status: "ended",
          results_url: "https://evil.example.com/results",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });
    await expect(provider.getBatch("b")).rejects.toThrow(/host/);
  });

  it("rejects a body over the size limit", async () => {
    await expect(readLimitedText(new Response("x".repeat(100)), 10)).rejects.toThrow(/large/);
  });
});

describe("config", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_OWNER_ID: "1",
    DATABASE_URL: "postgres://localhost/db",
  };

  it("does not require ANTHROPIC_API_KEY and has scoring defaults", () => {
    const env = parseEnv(base);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env).toMatchObject({
      SCORING_MODE: "batch",
      SCORING_DAILY_CAP: 100,
      SCORING_MAX_CHARS: 1500,
      LLM_DAILY_LIMIT_USD: 0.16,
      LLM_MONTHLY_LIMIT_USD: 5,
    });
  });

  it("reads the limits and the model from the environment", () => {
    const env = parseEnv({
      ...base,
      SCORING_MODE: "sync",
      SCORING_DAILY_CAP: "7",
      LLM_MODEL: "other-model",
    });
    expect(env).toMatchObject({
      SCORING_MODE: "sync",
      SCORING_DAILY_CAP: 7,
      LLM_MODEL: "other-model",
    });
  });
});

describe("golden evaluation", () => {
  it("computes precision and recall of keep", () => {
    const metrics = keepMetrics([
      { expected: "keep", predicted: "keep" },
      { expected: "keep", predicted: "keep" },
      { expected: "keep", predicted: "drop" },
      { expected: "drop", predicted: "keep" },
      { expected: "drop", predicted: "drop" },
    ]);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
    expect(keepMetrics([]).precision).toBeNull();
  });

  it("evaluates items with the fake provider and counts invalid output as drop", async () => {
    const answer = (relevance: number) => JSON.stringify({ ...validOutput, relevance });
    const provider = new FakeProvider((r) =>
      r.user.includes("keep-good")
        ? answer(9)
        : r.user.includes("keep-bad")
          ? "oops"
          : r.user.includes("drop-noise")
            ? answer(1)
            : answer(8),
    );
    const item = (title: string, label: "keep" | "drop") => ({
      id: title,
      title,
      snippet: "",
      label,
    });
    const report = await evaluateGolden({
      items: [
        item("keep-good", "keep"),
        item("keep-bad", "keep"),
        item("drop-noise", "drop"),
        item("drop-fp", "drop"),
      ],
      provider,
      profile,
      model: "m",
      maxChars: 1500,
      maxOutputTokens: 500,
      pricing,
      keepThreshold: 6,
      maxCostUsd: 1,
    });
    expect(report).toMatchObject({ evaluated: 4, invalid: 1, skippedForCost: 0 });
    expect(report.metrics).toMatchObject({ truePositive: 1, falsePositive: 1, falseNegative: 1 });
  });

  it("stops when the cost limit is reached", async () => {
    const provider = new FakeProvider(() => validJson);
    const report = await evaluateGolden({
      items: [{ id: "a", title: "a", snippet: "", label: "keep" }],
      provider,
      profile,
      model: "m",
      maxChars: 1500,
      maxOutputTokens: 500,
      pricing,
      keepThreshold: 6,
      maxCostUsd: 0,
    });
    expect(report.skippedForCost).toBe(1);
    expect(provider.requests).toHaveLength(0);
  });
});
