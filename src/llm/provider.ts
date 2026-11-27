/** One request to the model. The system text is the cached prefix. */
export interface LlmRequest {
  model: string;
  /** Prompt plus profile. The provider marks it for prompt caching. */
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
}

export interface BatchRequest {
  /** Letters, digits, "_" and "-", at most 64 characters. */
  customId: string;
  request: LlmRequest;
}

export type BatchEntryResult =
  | { customId: string; ok: true; response: LlmResponse }
  | { customId: string; ok: false; error: string };

export type BatchStatus =
  { status: "in_progress" } | { status: "ended"; results: BatchEntryResult[] };

/** The only way the pipeline talks to a language model. Tests use `FakeProvider`. */
export interface LlmProvider {
  /** Send one request and wait for the answer. Throw on a transport or API error. */
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Send many requests at the Batch API price. Return the provider batch id. */
  submitBatch(requests: BatchRequest[]): Promise<string>;
  /** Read a batch. When it has ended, return the result of every request. */
  getBatch(batchId: string): Promise<BatchStatus>;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** An answer for the fake provider: raw text, full response, or an error to throw. */
export type FakeAnswer = string | LlmResponse | Error;

/** Provider for tests. It never uses the network. */
export class FakeProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  readonly batches = new Map<string, BatchRequest[]>();
  /** Set to false to make `getBatch` report "in_progress". */
  batchEnded = true;
  private batchCounter = 0;

  constructor(
    private readonly answer: (request: LlmRequest) => FakeAnswer,
    private readonly usage: LlmUsage = { ...EMPTY_USAGE, inputTokens: 1000, outputTokens: 100 },
  ) {}

  private respond(request: LlmRequest): LlmResponse {
    const answer = this.answer(request);
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? { text: answer, usage: this.usage } : answer;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return this.respond(request);
  }

  async submitBatch(requests: BatchRequest[]): Promise<string> {
    const id = `fake-batch-${++this.batchCounter}`;
    this.batches.set(id, requests);
    return id;
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    const requests = this.batches.get(batchId);
    if (!requests) throw new Error(`Unknown batch ${batchId}`);
    if (!this.batchEnded) return { status: "in_progress" };
    const results = requests.map(({ customId, request }): BatchEntryResult => {
      try {
        return { customId, ok: true, response: this.respond(request) };
      } catch (error) {
        return { customId, ok: false, error: (error as Error).message };
      }
    });
    return { status: "ended", results };
  }
}
