import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  localDate,
  runDigest,
  type DigestClaim,
  type DigestItemRecord,
  type DigestRunOptions,
  type DigestStore,
  type MessageSender,
} from "../src/digest/run.js";
import type { ComposeStory } from "../src/llm/compose-schema.js";
import { FakeProvider } from "../src/llm/provider.js";
import type { UsageStore } from "../src/llm/score-store.js";
import type { DigestKind, RankedStory } from "../src/pipeline/rank.js";
import { profileSchema } from "../src/profile.js";

const profile = profileSchema.parse({
  version: 1,
  about_me: "A developer.",
  hard_exclusions: { description: "x", keywords: ["gossip"] },
  safety_exception: { description: "x", keywords: ["Antalya"] },
  topics: [
    {
      id: "ai",
      title: "Agentic AI",
      emoji: "🤖",
      weight: 1,
      description: "d",
      keywords: ["a1", "a2", "a3", "a4", "a5"],
    },
  ],
});

const logger = pino({ level: "silent" });
const now = new Date("2026-11-27T04:30:00Z");
const LEASE_MS = 10 * 60_000;

function ranked(storyId: number): RankedStory {
  return {
    storyId,
    title: `Story ${storyId}`,
    topics: ["ai"],
    relevance: 8,
    isRussiaDomestic: false,
    sourceTrust: 4,
    publishedAt: now,
    topic: "ai",
    score: 0.8,
  };
}

interface Row {
  id: number;
  kind: DigestKind;
  date: string;
  sentAt: Date | null;
  status: "claimed" | "sent" | "failed";
  claimedAt: Date;
  token: string;
  messageIds: number[];
  items: DigestItemRecord[];
}

/** In-memory store. It ranks the stories that no sent digest contains, as the database does. */
class FakeStore implements DigestStore {
  rows: Row[] = [];
  created = 0;
  filtered = { items: 214, sources: 38 };
  filteredCalls: number[][] = [];

  constructor(private readonly candidates: number[]) {}

  async findDigest(kind: DigestKind, date: string) {
    const row = this.rows.find((r) => r.kind === kind && r.date === date);
    return row ? { id: row.id, sentAt: row.sentAt } : null;
  }

  async rank() {
    const sent = new Set(
      this.rows.filter((r) => r.sentAt).flatMap((r) => r.items.map((i) => i.storyId)),
    );
    return this.candidates.filter((id) => !sent.has(id)).map(ranked);
  }

  async loadComposeStories(list: RankedStory[]): Promise<ComposeStory[]> {
    return list.map((r) => ({
      storyId: r.storyId,
      title: r.title,
      text: "Body",
      url: `https://example.com/${r.storyId}`,
      sourceName: "Example",
      sourceLanguage: "en",
      topic: r.topic,
      studyType: null,
      whyMeHint: null,
    }));
  }

  async countFilteredOut(_since: Date, shown: number[]) {
    this.filteredCalls.push(shown);
    return this.filtered;
  }

  async claimDigest(
    d: { kind: DigestKind; date: string; items: DigestItemRecord[] },
    at: Date,
  ): Promise<DigestClaim | null> {
    const old = this.rows.find((r) => r.kind === d.kind && r.date === d.date);
    if (old) {
      const expired = at.getTime() - old.claimedAt.getTime() > LEASE_MS;
      const takeable = old.status === "failed" || (old.status === "claimed" && expired);
      if (!takeable) return null;
      this.rows = this.rows.filter((r) => r !== old);
    }
    this.created++;
    const token = `token-${this.created}`;
    this.rows.push({
      id: this.created,
      kind: d.kind,
      date: d.date,
      sentAt: null,
      status: "claimed",
      claimedAt: at,
      token,
      messageIds: [],
      items: d.items,
    });
    return { digestId: this.created, token };
  }

  private owned(claim: DigestClaim) {
    return this.rows.find(
      (r) => r.id === claim.digestId && r.token === claim.token && r.status === "claimed",
    );
  }

  async markSent(claim: DigestClaim, messageIds: number[], sentAt: Date) {
    const row = this.owned(claim);
    if (!row) throw new Error("claim lost");
    row.status = "sent";
    row.sentAt = sentAt;
    row.messageIds = messageIds;
  }

  async releaseClaim(claim: DigestClaim) {
    const row = this.owned(claim);
    if (row) row.status = "failed";
  }
}

class FakeSender implements MessageSender {
  sent: { chatId: number; html: string }[] = [];
  failNext = 0;

  async send(chatId: number, html: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Telegram is down");
    }
    this.sent.push({ chatId, html });
    return 100 + this.sent.length;
  }
}

const usageStore: UsageStore = {
  spentSince: async () => 0,
  recordUsage: async () => true,
};

const composed = JSON.stringify({
  headline: "Sub-agents arrive",
  summary: "The release adds sub-agents.",
  why_me: "It changes your workflow.",
});

function setup(
  candidates: number[],
  provider: FakeProvider | null = new FakeProvider(() => composed),
) {
  const store = new FakeStore(candidates);
  const sender = new FakeSender();
  const lines: string[] = [];
  const options = (over: Partial<DigestRunOptions> = {}): DigestRunOptions => ({
    store,
    sender,
    usageStore,
    provider,
    logger,
    profile,
    kind: "morning",
    language: "en",
    timeZone: "Europe/Istanbul",
    chatId: 42,
    dryRun: false,
    print: (text) => lines.push(text),
    now: () => now,
    windowHours: 24,
    model: "fake-model",
    maxChars: 1500,
    maxOutputTokens: 800,
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      batchFactor: 0.5,
    },
    dailyLimitUsd: 10,
    monthlyLimitUsd: 100,
    ...over,
  });
  return { store, sender, lines, options, provider };
}

describe("localDate", () => {
  it("uses the time zone of the owner", () => {
    const late = new Date("2026-11-26T22:30:00Z");
    expect(localDate(late, "UTC")).toBe("2026-11-26");
    expect(localDate(late, "Europe/Istanbul")).toBe("2026-11-27");
  });
});

describe("runDigest", () => {
  it("sends a digest once and sends nothing for the same slot again", async () => {
    const { store, sender, options, provider } = setup([1, 2]);
    const first = await runDigest(options());
    expect(first).toMatchObject({ status: "sent", stories: 2, messages: 1 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.chatId).toBe(42);
    expect(sender.sent[0]!.html).toContain("Filtered out: 214 items from 38 sources.");
    expect(store.rows[0]).toMatchObject({ date: "2026-11-27", messageIds: [101] });
    expect(store.rows[0]!.sentAt).not.toBeNull();
    expect(store.rows[0]!.items.map((i) => i.storyId)).toEqual([1, 2]);
    // The footer counts exclude the shown stories.
    expect(store.filteredCalls[0]).toEqual([1, 2]);
    const calls = provider!.requests.length;

    const second = await runDigest(options());
    expect(second.status).toBe("already_sent");
    expect(sender.sent).toHaveLength(1);
    // No new LLM call for the second run.
    expect(provider!.requests).toHaveLength(calls);
  });

  it("prints the messages in a dry run and writes nothing", async () => {
    const { store, sender, lines, options } = setup([1]);
    const result = await runDigest(options({ dryRun: true }));
    expect(result).toMatchObject({ status: "dry_run", stories: 1, digestId: null });
    expect(sender.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    expect(store.created).toBe(0);
    expect(lines.join("\n")).toContain("Sub-agents arrive");
    // A later real run still sends the same story.
    expect((await runDigest(options())).status).toBe("sent");
    expect(sender.sent).toHaveLength(1);
  });

  it("keeps the stories unsent after a failed send and sends them on retry", async () => {
    const { store, sender, options } = setup([1, 2]);
    sender.failNext = 1;
    await expect(runDigest(options())).rejects.toThrow("Telegram send failed: Telegram is down");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.sentAt).toBeNull();
    // The stories are still ranked.
    expect((await store.rank()).map((r) => r.storyId)).toEqual([1, 2]);

    const retry = await runDigest(options());
    expect(retry).toMatchObject({ status: "sent", stories: 2 });
    expect(sender.sent).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.sentAt).not.toBeNull();
    expect(await store.rank()).toEqual([]);
  });

  it("does not send or delete anything when a second run starts during the first send", async () => {
    const { store, sender, options } = setup([1, 2]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => {
      sender.send = async (chatId, html) => {
        resolve();
        await gate;
        sender.sent.push({ chatId, html });
        return 101;
      };
    });
    const first = runDigest(options());
    await started;
    const second = await runDigest(options());
    expect(second.status).toBe("in_progress");
    expect(sender.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "claimed", id: 1 });
    expect(store.rows[0]!.items).toHaveLength(2);

    release();
    expect((await first).status).toBe("sent");
    expect(sender.sent).toHaveLength(1);
    expect(store.rows[0]!.status).toBe("sent");
  });

  it("takes over a claim whose lease expired", async () => {
    const { store, sender, options } = setup([1]);
    // A crashed run left a claim behind.
    await store.claimDigest({ kind: "morning", date: "2026-11-27", items: [] }, now);
    const later = new Date(now.getTime() + LEASE_MS + 1000);
    const result = await runDigest(options({ now: () => later }));
    expect(result.status).toBe("sent");
    expect(sender.sent).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.status).toBe("sent");
  });

  it("does not take over a claim inside the lease", async () => {
    const { store, sender, options } = setup([1]);
    await store.claimDigest({ kind: "morning", date: "2026-11-27", items: [] }, now);
    const soon = new Date(now.getTime() + LEASE_MS - 1000);
    expect((await runDigest(options({ now: () => soon }))).status).toBe("in_progress");
    expect(sender.sent).toHaveLength(0);
    expect(store.rows[0]!.status).toBe("claimed");
  });

  it("marks the digest failed after a failed send", async () => {
    const { store, sender, options } = setup([1]);
    sender.failNext = 1;
    await expect(runDigest(options())).rejects.toThrow("Telegram send failed");
    expect(store.rows[0]!.status).toBe("failed");
  });

  it("raises an error when markSent runs with a lost claim", async () => {
    const { store } = setup([1]);
    const stale = (await store.claimDigest(
      { kind: "morning", date: "2026-11-27", items: [] },
      now,
    ))!;
    await store.releaseClaim(stale);
    await store.claimDigest(
      { kind: "morning", date: "2026-11-27", items: [] },
      new Date(now.getTime() + 1000),
    );
    await expect(store.markSent(stale, [1], now)).rejects.toThrow("claim lost");
  });

  it("sends a short message on a quiet day and never pads", async () => {
    const { store, sender, options, provider } = setup([]);
    const result = await runDigest(options());
    expect(result).toMatchObject({ status: "sent", stories: 0, messages: 1 });
    expect(sender.sent[0]!.html).toContain("Nothing important today.");
    expect(sender.sent[0]!.html).toContain("Filtered out: 214 items from 38 sources.");
    expect(provider!.requests).toHaveLength(0);
    expect(store.rows[0]!.items).toEqual([]);
    expect((await runDigest(options())).status).toBe("already_sent");
    expect(sender.sent).toHaveLength(1);
  });

  it("writes the quiet message in Russian when the language is ru", async () => {
    const { sender, options } = setup([]);
    await runDigest(options({ language: "ru" }));
    expect(sender.sent[0]!.html).toContain("Ничего важного сегодня.");
  });

  it("treats morning and evening as separate slots", async () => {
    const { sender, options } = setup([]);
    await runDigest(options({ kind: "morning" }));
    await runDigest(options({ kind: "evening" }));
    expect(sender.sent).toHaveLength(2);
  });

  it("fails and sends nothing when stories are ranked but none can be composed", async () => {
    const { store, sender, options } = setup([1], null);
    await expect(runDigest(options())).rejects.toThrow("No story could be composed");
    expect(sender.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("sends the stories that were composed and keeps the others unsent", async () => {
    const answers = [composed, "not json"];
    const provider = new FakeProvider(() => answers.shift()!);
    const { store, sender, options } = setup([1, 2], provider);
    const result = await runDigest(options());
    expect(result.stories).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(store.rows[0]!.items.map((i) => i.storyId)).toEqual([1]);
    expect((await store.rank()).map((r) => r.storyId)).toEqual([2]);
  });
});
