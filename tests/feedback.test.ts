import { describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { encodeFeedback, feedbackKeyboard, parseFeedback } from "../src/feedback/callback.js";
import {
  computeAdjustments,
  DEFAULT_FEEDBACK_CONFIG,
  multiplierFor,
  nextVote,
  type FeedbackConfig,
  type VoteRecord,
} from "../src/feedback/rules.js";
import type { FeedbackStore, VoteOutcome } from "../src/feedback/store.js";
import { feedbackConfig, parseEnv } from "../src/config.js";

const config = DEFAULT_FEEDBACK_CONFIG;
const vote = (kind: "up" | "down", topics: string[], sourceId: number | null = 1): VoteRecord => ({
  kind,
  topics,
  sourceId,
});

describe("callback data", () => {
  it("round-trips and stays under the 64-byte limit", () => {
    const action = { digestId: 999_999_999_999, position: 12, vote: "down" as const };
    const data = encodeFeedback(action);
    expect(data).toBe("f:999999999999:12:d");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseFeedback(data)).toEqual(action);
    expect(parseFeedback("f:5:1:u")).toEqual({ digestId: 5, position: 1, vote: "up" });
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "x:1:1:u",
      "f:1:1:x",
      "f:0:1:u",
      "f:1:0:u",
      "f:1:1:u:extra",
      "f:-1:1:u",
      "f:1e3:1:u",
      "f:1:1",
    ]) {
      expect(parseFeedback(bad), bad).toBeNull();
    }
  });

  it("builds one row with two buttons for each item", () => {
    const keyboard = feedbackKeyboard(7, [3, 4]);
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "👍 3", callback_data: "f:7:3:u" },
        { text: "👎 3", callback_data: "f:7:3:d" },
      ],
      [
        { text: "👍 4", callback_data: "f:7:4:u" },
        { text: "👎 4", callback_data: "f:7:4:d" },
      ],
    ]);
  });
});

describe("nextVote", () => {
  it("sets, changes and clears a vote", () => {
    expect(nextVote(null, "up")).toBe("up");
    expect(nextVote("up", "up")).toBeNull();
    expect(nextVote("up", "down")).toBe("down");
    expect(nextVote("down", "up")).toBe("up");
  });
});

describe("adjustment rules", () => {
  it("moves a multiplier by 5% per vote", () => {
    expect(multiplierFor(1, 0.05, 0.5, 1.5)).toBe(1.05);
    expect(multiplierFor(-2, 0.05, 0.5, 1.5)).toBe(0.9);
    expect(multiplierFor(0, 0.05, 0.5, 1.5)).toBe(1);
  });

  it("never leaves the bounds", () => {
    expect(multiplierFor(1000, 0.05, 0.5, 1.5)).toBe(1.5);
    expect(multiplierFor(-1000, 0.05, 0.5, 1.5)).toBe(0.5);
    const many = Array.from({ length: 500 }, () => vote("up", ["ai"], 1));
    const down = Array.from({ length: 500 }, () => vote("down", ["med"], 2));
    const result = computeAdjustments([...many, ...down], config);
    expect(result.topics.get("ai")).toBe(config.topicMax);
    expect(result.topics.get("med")).toBe(config.topicMin);
    expect(result.sources.get(1)).toBe(config.sourceMax);
    expect(result.sources.get(2)).toBe(config.sourceMin);
  });

  it("uses the configured step and bounds", () => {
    const tight: FeedbackConfig = {
      step: 0.1,
      topicMin: 0.9,
      topicMax: 1.1,
      sourceMin: 0.8,
      sourceMax: 1.2,
    };
    const ups = [vote("up", ["ai"]), vote("up", ["ai"]), vote("up", ["ai"])];
    const result = computeAdjustments(ups, tight);
    expect(result.topics.get("ai")).toBe(1.1);
    expect(result.sources.get(1)).toBe(1.2);
  });

  it("nudges every topic and the source of a story", () => {
    const result = computeAdjustments([vote("up", ["ai", "med"], 3)], config);
    expect([...result.topics]).toEqual([
      ["ai", 1.05],
      ["med", 1.05],
    ]);
    expect([...result.sources]).toEqual([[3, 1.05]]);
  });

  it("counts a repeated topic of one story once and skips a missing source", () => {
    const result = computeAdjustments([vote("down", ["ai", "ai"], null)], config);
    expect(result.topics.get("ai")).toBe(0.95);
    expect(result.sources.size).toBe(0);
  });

  it("leaves out a multiplier of 1", () => {
    const result = computeAdjustments([vote("up", ["ai"]), vote("down", ["ai"])], config);
    expect(result.topics.size).toBe(0);
    expect(result.sources.size).toBe(0);
  });

  it("is deterministic: order does not matter, and a changed vote is a recomputation", () => {
    const votes = [vote("up", ["ai"], 1), vote("down", ["ai"], 2), vote("up", ["med"], 1)];
    const first = computeAdjustments(votes, config);
    expect(computeAdjustments([...votes].reverse(), config)).toEqual(first);
    // The second vote changes from down to up, then back to down: the result is the same as before.
    const changed = computeAdjustments([votes[0]!, vote("up", ["ai"], 2), votes[2]!], config);
    expect(changed.topics.get("ai")).toBe(1.1);
    const restored = computeAdjustments([votes[0]!, vote("down", ["ai"], 2), votes[2]!], config);
    expect(restored).toEqual(first);
  });
});

describe("config", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "1", DATABASE_URL: "postgres://x" };

  it("has defaults of 5% and [0.5, 1.5]", () => {
    expect(feedbackConfig(parseEnv(env))).toEqual(config);
  });

  it("rejects bounds that exclude 1", () => {
    expect(() => parseEnv({ ...env, FEEDBACK_TOPIC_MIN: "1.2" })).toThrow();
    expect(() => parseEnv({ ...env, FEEDBACK_SOURCE_MAX: "0.9" })).toThrow();
    expect(() => parseEnv({ ...env, FEEDBACK_STEP: "0" })).toThrow();
  });
});

describe("callback_query handler", () => {
  /** An in-memory store with the same toggle rule as the database store. */
  class FakeFeedbackStore implements FeedbackStore {
    votes = new Map<string, "up" | "down">();
    calls = 0;
    async press(
      userId: number,
      action: { digestId: number; position: number; vote: "up" | "down" },
    ): Promise<VoteOutcome> {
      this.calls++;
      if (action.digestId === 404) return { status: "not_found" };
      const key = `${userId}:${action.digestId}:${action.position}`;
      const next = nextVote(this.votes.get(key) ?? null, action.vote);
      if (next) this.votes.set(key, next);
      else this.votes.delete(key);
      return { status: "stored", vote: next };
    }
  }

  function setup() {
    const store = new FakeFeedbackStore();
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({ token: "123:abc", ownerId: 1, db: {} as never, feedbackStore: store });
    bot.botInfo = { id: 123, is_bot: true, first_name: "t", username: "t_bot" } as never;
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return Promise.resolve({ ok: true, result: true } as never);
    });
    const press = (fromId: number, data: string) =>
      bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb1",
          chat_instance: "ci",
          from: { id: fromId, is_bot: false, first_name: "x" },
          data,
          message: {
            message_id: 5,
            date: 0,
            chat: { id: fromId, type: "private", first_name: "x" },
          },
        },
      } as never);
    return { store, calls, press };
  }

  it("ignores a press from another user and answers nothing", async () => {
    const { store, calls, press } = setup();
    await press(2, "f:1:1:u");
    expect(store.calls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("stores the vote of the owner and acknowledges it", async () => {
    const { store, calls, press } = setup();
    await press(1, "f:1:1:u");
    expect(store.votes.get("1:1:1")).toBe("up");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("answerCallbackQuery");
    expect(calls[0]!.payload).toMatchObject({ callback_query_id: "cb1", text: "👍 Noted" });
  });

  it("changes the vote on the other button and clears it on a repeated press", async () => {
    const { store, calls, press } = setup();
    await press(1, "f:1:1:u");
    await press(1, "f:1:1:d");
    expect(store.votes.get("1:1:1")).toBe("down");
    await press(1, "f:1:1:d");
    expect(store.votes.size).toBe(0);
    expect(calls.map((c) => c.payload.text)).toEqual(["👍 Noted", "👎 Noted", "Vote removed"]);
  });

  it("answers a press on an unknown item, and ignores a payload that is not feedback", async () => {
    const { store, calls, press } = setup();
    await press(1, "f:404:1:u");
    await press(1, "other");
    expect(store.calls).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "answerCallbackQuery"]);
    expect(calls[0]!.payload.text).toBe("This item is no longer available.");
    expect(calls[1]!.payload.text).toBeUndefined();
  });

  it("still answers when the store fails", async () => {
    const { store, calls, press } = setup();
    store.press = () => Promise.reject(new Error("db down"));
    const spy = console.error;
    console.error = () => {};
    try {
      await press(1, "f:1:1:u");
    } finally {
      console.error = spy;
    }
    expect(calls[0]!.payload.text).toBe("Could not save the vote. Try again.");
  });
});
