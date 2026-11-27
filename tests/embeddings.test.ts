import { describe, expect, it } from "vitest";
import { createHostedEmbeddingsClient } from "../src/pipeline/embeddings.js";

const DIMS = 3;

function okResponse(count: number, offset = 0): Response {
  const data = Array.from({ length: count }, (_, index) => ({
    index,
    embedding: [offset + index, 1, 0],
  }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createHostedEmbeddingsClient({
    apiKey: "key",
    url: "https://embeddings.example/v1",
    model: "m",
    userAgent: "test",
    dimensions: DIMS,
    batchSize: 2,
    baseDelayMs: 1,
    sleep: async () => {},
    fetchImpl,
    ...extra,
  });
}

describe("hosted embeddings client", () => {
  it("splits texts into batches and keeps the order", async () => {
    const sizes: number[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      sizes.push(body.input.length);
      return okResponse(body.input.length, sizes.length * 10);
    }) as unknown as typeof fetch;
    const vectors = await client(fetchImpl).embed(["a", "b", "c"]);
    expect(sizes).toEqual([2, 1]);
    expect(vectors.map((v) => v[0])).toEqual([10, 11, 20]);
  });

  it("retries a 503 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3 ? new Response("down", { status: 503 }) : okResponse(1);
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).embed(["a"])).resolves.toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("does not retry a 401 and throws", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("no", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).embed(["a"])).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("throws after the last attempt", async () => {
    const fetchImpl = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    await expect(client(fetchImpl, { maxAttempts: 2 }).embed(["a"])).rejects.toThrow(/500/);
  });

  it("throws on a wrong size, a missing vector and an oversized body", async () => {
    const wrongSize = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }))) as never;
    await expect(client(wrongSize).embed(["a"])).rejects.toThrow(/finite numbers/);

    const missing = (async () => okResponse(1)) as never;
    await expect(client(missing).embed(["a", "b"])).rejects.toThrow(/missing/);

    const big = (async () => okResponse(2)) as never;
    await expect(client(big, { maxResponseBytes: 10 }).embed(["a", "b"])).rejects.toThrow(
      /too large/,
    );
  });

  it("throws on invalid JSON", async () => {
    const fetchImpl = (async () => new Response("<html>")) as never;
    await expect(client(fetchImpl).embed(["a"])).rejects.toThrow(/not valid JSON/);
  });
});
