import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../db/schema.js";
import { readCappedText } from "./robots.js";

/** Turns texts into vectors. The result has one vector per text, in the same order. */
export interface EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingsError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** Pause that the server asked for with `Retry-After`, in ms. Null when absent or invalid. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "EmbeddingsError";
  }
}

export interface HostedEmbeddingsOptions {
  apiKey: string;
  url: string;
  model: string;
  userAgent: string;
  /** Texts per request. */
  batchSize?: number;
  /** Total attempts per request, including the first one. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Total attempts per request after HTTP 429, including the first one. */
  maxRateLimitAttempts?: number;
  /** Longest single pause after HTTP 429, in ms. */
  maxRateLimitDelayMs?: number;
  /** Cap on the total pause after HTTP 429 in one `embed` call, in ms. */
  maxRateLimitWaitMs?: number;
  timeoutMs?: number;
  /** Maximum bytes to read from one response. */
  maxResponseBytes?: number;
  dimensions?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Random number in [0, 1) for the jitter. */
  random?: () => number;
  now?: () => number;
}

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number()) })),
});

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Read `Retry-After`: a number of seconds or an HTTP date. Null when absent or invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/**
 * Client for a hosted embeddings API with the Voyage request format:
 * `POST { input: string[], model }` returns `{ data: [{ index, embedding }] }`.
 * It splits the texts into batches and retries 408, 429 and 5xx with backoff.
 * After HTTP 429 it waits for `Retry-After`, or backs off up to `maxRateLimitDelayMs` with
 * jitter. It allows more attempts for 429, but the total wait of one `embed` call is capped.
 * It throws on any partial or invalid result.
 */
export function createHostedEmbeddingsClient(options: HostedEmbeddingsOptions): EmbeddingsClient {
  const batchSize = options.batchSize ?? 64;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 8_000_000;
  const maxRateLimitAttempts = options.maxRateLimitAttempts ?? 8;
  const maxRateLimitDelayMs = options.maxRateLimitDelayMs ?? 60_000;
  const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 240_000;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  async function requestOnce(input: string[]): Promise<number[][]> {
    const response = await doFetch(options.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": options.userAgent,
      },
      body: JSON.stringify({ input, model: options.model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmbeddingsError(
        `Embeddings API returned HTTP ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after"), now()),
      );
    }
    // Read one byte more than the limit, so that a truncated body is detected.
    const body = await readCappedText(response, maxBytes + 1);
    if (Buffer.byteLength(body) > maxBytes) {
      throw new EmbeddingsError("Embeddings response is too large");
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new EmbeddingsError("Embeddings response is not valid JSON");
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new EmbeddingsError("Embeddings response has an unexpected shape");
    const vectors: (number[] | undefined)[] = new Array<number[] | undefined>(input.length).fill(
      undefined,
    );
    for (const entry of parsed.data.data) {
      if (entry.index >= input.length || vectors[entry.index]) {
        throw new EmbeddingsError("Embeddings response has a bad index");
      }
      if (entry.embedding.length !== dimensions || !entry.embedding.every(Number.isFinite)) {
        throw new EmbeddingsError(`Embeddings must have ${dimensions} finite numbers`);
      }
      vectors[entry.index] = entry.embedding;
    }
    if (vectors.some((v) => v === undefined)) {
      throw new EmbeddingsError("Embeddings response is missing vectors");
    }
    return vectors as number[][];
  }

  /** `budget.waitedMs` is the total pause after HTTP 429 in the current `embed` call. */
  async function requestWithRetry(
    input: string[],
    budget: { waitedMs: number },
  ): Promise<number[][]> {
    let lastError: unknown;
    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      try {
        return await requestOnce(input);
      } catch (error) {
        lastError = error;
        const status = error instanceof EmbeddingsError ? error.status : null;
        const retryable =
          error instanceof EmbeddingsError ? status !== null && isRetryable(status) : true; // network error or timeout
        if (!retryable) break;
        let delay: number;
        if (status === 429) {
          rateLimits++;
          if (rateLimits >= maxRateLimitAttempts) break;
          const asked = (error as EmbeddingsError).retryAfterMs;
          delay =
            asked !== null
              ? asked
              : Math.min(maxRateLimitDelayMs, 2000 * 2 ** (rateLimits - 1)) * (0.5 + random() / 2);
          // Give up at once when the wait would pass the cap, so that the run cannot hang.
          if (delay > maxRateLimitDelayMs || budget.waitedMs + delay > maxRateLimitWaitMs) break;
          budget.waitedMs += delay;
        } else {
          failures++;
          if (failures >= maxAttempts) break;
          delay = baseDelayMs * 2 ** (failures - 1);
        }
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new EmbeddingsError(String(lastError));
  }

  return {
    async embed(texts) {
      const out: number[][] = [];
      const budget = { waitedMs: 0 };
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await requestWithRetry(texts.slice(i, i + batchSize), budget)));
      }
      return out;
    },
  };
}
