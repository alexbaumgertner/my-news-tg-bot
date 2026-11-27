import { GrammyError, HttpError } from "grammy";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { classifySendError, withRetry } from "../src/digest/retry.js";
import type { MessageSender } from "../src/digest/run.js";

const logger = pino({ level: "silent" });

function apiError(code: number, parameters: Record<string, unknown> = {}): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${code})`,
    { ok: false, error_code: code, description: `error ${code}`, parameters },
    "sendMessage",
    {},
  );
}

/** A sender that fails with the given errors, then succeeds. */
function flaky(errors: unknown[]) {
  let calls = 0;
  const sender: MessageSender = {
    async send() {
      calls++;
      const error = errors.shift();
      if (error) throw error;
      return 7;
    },
  };
  return { sender, calls: () => calls };
}

describe("classifySendError", () => {
  it("retries a network error", () => {
    expect(classifySendError(new HttpError("network", new Error("reset")))).toEqual({
      retry: true,
    });
  });

  it("retries 429 after the retry_after of Telegram", () => {
    expect(classifySendError(apiError(429, { retry_after: 3 }))).toEqual({
      retry: true,
      delayMs: 3000,
    });
  });

  it("retries 5xx", () => {
    expect(classifySendError(apiError(502))).toEqual({ retry: true });
  });

  it("does not retry other 4xx or an unknown error", () => {
    expect(classifySendError(apiError(400))).toEqual({ retry: false });
    expect(classifySendError(apiError(403))).toEqual({ retry: false });
    expect(classifySendError(new Error("boom"))).toEqual({ retry: false });
  });
});

describe("withRetry", () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const options = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

  it("waits for retry_after on 429 and then succeeds", async () => {
    waits.length = 0;
    const { sender, calls } = flaky([apiError(429, { retry_after: 1 })]);
    await expect(withRetry(sender, logger, options, sleep).send(1, "x")).resolves.toBe(7);
    expect(calls()).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("retries 5xx with a growing backoff", async () => {
    waits.length = 0;
    const { sender, calls } = flaky([apiError(500), apiError(502)]);
    await expect(withRetry(sender, logger, options, sleep).send(1, "x")).resolves.toBe(7);
    expect(calls()).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("gives up after the maximum number of attempts", async () => {
    waits.length = 0;
    const { sender, calls } = flaky([apiError(500), apiError(500), apiError(500), apiError(500)]);
    await expect(withRetry(sender, logger, options, sleep).send(1, "x")).rejects.toThrow("500");
    expect(calls()).toBe(3);
  });

  it("does not retry 400", async () => {
    waits.length = 0;
    const { sender, calls } = flaky([apiError(400)]);
    await expect(withRetry(sender, logger, options, sleep).send(1, "x")).rejects.toThrow("400");
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("does not wait for a retry_after above the maximum", async () => {
    waits.length = 0;
    const { sender, calls } = flaky([apiError(429, { retry_after: 3600 })]);
    await expect(withRetry(sender, logger, options, sleep).send(1, "x")).rejects.toThrow("429");
    expect(calls()).toBe(1);
  });

  it("does not send an accepted message again", async () => {
    // The first message is accepted. Only the second one fails and is retried.
    const sent: string[] = [];
    let failOnce = true;
    const sender: MessageSender = {
      async send(_chatId, html) {
        if (html === "second" && failOnce) {
          failOnce = false;
          throw apiError(500);
        }
        sent.push(html);
        return sent.length;
      },
    };
    const wrapped = withRetry(sender, logger, options, sleep);
    await wrapped.send(1, "first");
    await wrapped.send(1, "second");
    expect(sent).toEqual(["first", "second"]);
  });
});
