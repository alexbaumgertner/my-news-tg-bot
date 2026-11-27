import { GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { MessageSender } from "./run.js";

export interface RetryOptions {
  /** Attempts for one message, the first one included. Default: 4. */
  maxAttempts: number;
  /** Delay before the second attempt. It doubles for each later attempt. Default: 1000 ms. */
  baseDelayMs: number;
  /** The longest wait that the policy accepts, also for `retry_after`. Default: 30 000 ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** The decision for one failed send. `delayMs` is set only when `retry` is true. */
export type RetryDecision = { retry: false } | { retry: true; delayMs?: number };

/**
 * Decide if a failed send can be retried. Only a transient error is retried:
 * - a network error (grammY `HttpError`);
 * - 429, after the `retry_after` seconds that Telegram asks for;
 * - 5xx.
 * Any other 4xx means that Telegram refused the message. A retry cannot help.
 * An error of an unknown kind is not retried.
 */
export function classifySendError(error: unknown): RetryDecision {
  if (error instanceof HttpError) return { retry: true };
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const seconds = error.parameters.retry_after;
      return typeof seconds === "number" && seconds >= 0
        ? { retry: true, delayMs: seconds * 1000 }
        : { retry: true };
    }
    return { retry: error.error_code >= 500 };
  }
  return { retry: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a sender with a retry policy. A retry repeats one message only, so a message that
 * Telegram already accepted is never sent again. The wait for a 429 is the `retry_after`
 * of Telegram. When that wait is longer than `maxDelayMs`, the error is thrown at once.
 */
export function withRetry(
  sender: MessageSender,
  logger: Logger,
  options: Partial<RetryOptions> = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): MessageSender {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_OPTIONS, ...options };
  return {
    async send(chatId, html) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await sender.send(chatId, html);
        } catch (error) {
          const decision = classifySendError(error);
          if (!decision.retry || attempt >= maxAttempts) throw error;
          const delayMs =
            decision.delayMs ?? Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
          if (delayMs > maxDelayMs) throw error;
          logger.warn(
            { attempt, maxAttempts, delayMs, error: errorMessage(error) },
            "Telegram send failed with a transient error. Retrying.",
          );
          await sleep(delayMs);
        }
      }
    },
  };
}
