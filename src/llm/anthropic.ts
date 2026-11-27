import { z } from "zod";
import type {
  BatchEntryResult,
  BatchRequest,
  BatchStatus,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
} from "./provider.js";

const API_BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_BATCH_RESULTS_BYTES = 8_000_000;
const MAX_BATCH_REQUESTS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

const usageSchema = z.object({
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  cache_read_input_tokens: z.number().int().min(0).nullish(),
  cache_creation_input_tokens: z.number().int().min(0).nullish(),
});

const messageSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: usageSchema,
  stop_reason: z.string().nullish(),
});

const batchSchema = z.object({
  id: z.string().min(1),
  processing_status: z.string(),
  results_url: z.string().url().nullish(),
});

const batchLineSchema = z.object({
  custom_id: z.string().min(1),
  result: z.object({ type: z.string(), message: messageSchema.optional() }).loose(),
});

/** Read a body as text. Throw when it is larger than `maxBytes`. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new AnthropicError("Response is too large", response.status);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AnthropicError("Response is too large", response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toResponse(message: z.infer<typeof messageSchema>): LlmResponse {
  const usage: LlmUsage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  // A cut answer is never valid JSON. Return it as text and let the validator reject it.
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return { text, usage };
}

function params(request: LlmRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    // One cached block: the prompt and the profile. It is the same for every story.
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.user }],
  };
}

export interface AnthropicOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Anthropic Messages API and Message Batches API over `fetch`. No SDK. */
export class AnthropicProvider implements LlmProvider {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AnthropicOptions) {
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async send(url: string, init: RequestInit, maxBytes: number): Promise<string> {
    const response = await this.doFetch(url, {
      ...init,
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Read a short part of the error body. Never log the key or the request.
      const body = await readLimitedText(response, 10_000).catch(() => "");
      throw new AnthropicError(
        `Anthropic API error ${response.status}: ${body.slice(0, 300)}`,
        response.status,
      );
    }
    return readLimitedText(response, maxBytes);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body = await this.send(
      `${API_BASE}/messages`,
      { method: "POST", body: JSON.stringify(params(request)) },
      MAX_RESPONSE_BYTES,
    );
    return toResponse(messageSchema.parse(JSON.parse(body)));
  }

  async submitBatch(requests: BatchRequest[]): Promise<string> {
    if (requests.length === 0 || requests.length > MAX_BATCH_REQUESTS) {
      throw new AnthropicError(`A batch needs 1 to ${MAX_BATCH_REQUESTS} requests`, null);
    }
    const body = await this.send(
      `${API_BASE}/messages/batches`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: requests.map((r) => ({ custom_id: r.customId, params: params(r.request) })),
        }),
      },
      MAX_RESPONSE_BYTES,
    );
    return batchSchema.parse(JSON.parse(body)).id;
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    const body = await this.send(
      `${API_BASE}/messages/batches/${encodeURIComponent(batchId)}`,
      { method: "GET" },
      MAX_RESPONSE_BYTES,
    );
    const batch = batchSchema.parse(JSON.parse(body));
    if (batch.processing_status !== "ended") return { status: "in_progress" };
    if (!batch.results_url) throw new AnthropicError("Ended batch has no results_url", null);
    // Send the key only to the Anthropic host.
    if (new URL(batch.results_url).origin !== new URL(API_BASE).origin) {
      throw new AnthropicError("Unexpected results_url host", null);
    }
    const text = await this.send(batch.results_url, { method: "GET" }, MAX_BATCH_RESULTS_BYTES);
    const results: BatchEntryResult[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = batchLineSchema.parse(JSON.parse(line));
      if (parsed.result.type === "succeeded" && parsed.result.message) {
        results.push({
          customId: parsed.custom_id,
          ok: true,
          response: toResponse(parsed.result.message),
        });
      } else {
        results.push({ customId: parsed.custom_id, ok: false, error: parsed.result.type });
      }
    }
    return { status: "ended", results };
  }
}
