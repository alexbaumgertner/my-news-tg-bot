import { describe, expect, it } from "vitest";
import {
  type RankCandidate,
  freshness,
  selectForDigest,
  storyScore,
} from "../src/pipeline/rank.js";
import { profileSchema } from "../src/profile.js";

const now = new Date("2026-11-27T07:30:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

const topic = (id: string, weight: number, mode: "digest" | "notice" = "digest") => ({
  id,
  title: id,
  weight,
  mode,
  description: "d",
  keywords: ["a1", "a2", "a3", "a4", "a5"],
});

const profile = profileSchema.parse({
  version: 1,
  about_me: "test",
  hard_exclusions: { description: "x", keywords: ["gossip"] },
  safety_exception: { description: "x", keywords: ["Antalya"] },
  topics: [topic("ai", 1), topic("med", 0.5), topic("books", 1, "notice")],
});

let nextId = 1;
const story = (over: Partial<RankCandidate> = {}): RankCandidate => ({
  storyId: nextId++,
  title: "t",
  topics: ["ai"],
  relevance: 8,
  isRussiaDomestic: false,
  sourceTrust: 4,
  publishedAt: now,
  ...over,
});

describe("storyScore", () => {
  it("multiplies relevance, weight, trust and freshness", () => {
    const c = story({ relevance: 10, sourceTrust: 4, publishedAt: hoursAgo(24) });
    // 1 × 0.5 × 0.8 × 0.5, no bonus for trust 4.
    expect(storyScore(c, 0.5, now)).toBeCloseTo(0.2);
  });

  it("adds the bonus for a primary source only", () => {
    const base = { relevance: 10, publishedAt: now };
    expect(storyScore({ ...base, sourceTrust: 5 }, 1, now)).toBeCloseTo(1.05);
    expect(storyScore({ ...base, sourceTrust: 4 }, 1, now)).toBeCloseTo(0.8);
  });

  it("halves freshness per half-life and treats a future date as new", () => {
    expect(freshness(hoursAgo(48), now, 24)).toBeCloseTo(0.25);
    expect(freshness(new Date(now.getTime() + 3_600_000), now, 24)).toBe(1);
  });
});

describe("selectForDigest", () => {
  it("orders by score and breaks ties by story id", () => {
    const a = story({ storyId: 20 });
    const b = story({ storyId: 10 });
    const c = story({ storyId: 30, relevance: 9 });
    const out = selectForDigest([a, b, c], profile, "morning", now, new Set());
    expect(out.map((s) => s.storyId)).toEqual([30, 10, 20]);
  });

  it("is deterministic for any input order", () => {
    const list = Array.from({ length: 6 }, (_, i) => story({ relevance: 5 + (i % 3) }));
    const first = selectForDigest(list, profile, "morning", now, new Set());
    const second = selectForDigest([...list].reverse(), profile, "morning", now, new Set());
    expect(second).toEqual(first);
  });

  it("keeps at most 3 items per topic and fills from other topics", () => {
    const ai = Array.from({ length: 5 }, () => story({ relevance: 10 }));
    const med = story({ topics: ["med"], relevance: 6 });
    const out = selectForDigest([...ai, med], profile, "morning", now, new Set());
    expect(out.filter((s) => s.topic === "ai")).toHaveLength(3);
    expect(out.map((s) => s.storyId)).toContain(med.storyId);
    expect(out).toHaveLength(4);
  });

  it("limits a morning digest to 7 and an evening digest to 5", () => {
    const topics = ["ai", "med"];
    const many = Array.from({ length: 12 }, (_, i) => story({ topics: [topics[i % 2]!] }));
    // 2 topics × 3 per topic = 6 at most, so use more topics for the digest limit.
    const wide = profileSchema.parse({
      ...profile,
      topics: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => topic(id, 1)),
    });
    const spread = Array.from({ length: 8 }, (_, i) => story({ topics: [`t${i + 1}`] }));
    expect(selectForDigest(spread, wide, "morning", now, new Set())).toHaveLength(7);
    expect(selectForDigest(spread, wide, "evening", now, new Set())).toHaveLength(5);
    expect(selectForDigest(many, profile, "morning", now, new Set())).toHaveLength(6);
  });

  it("excludes stories that were already sent", () => {
    const a = story();
    const b = story();
    const out = selectForDigest([a, b], profile, "morning", now, new Set([a.storyId]));
    expect(out.map((s) => s.storyId)).toEqual([b.storyId]);
  });

  it("does not pad a quiet day", () => {
    const good = story();
    const weak = story({ relevance: 3 });
    const russia = story({ isRussiaDomestic: true });
    const unknownTopic = story({ topics: ["cooking"] });
    const notice = story({ topics: ["books"] });
    const out = selectForDigest(
      [good, weak, russia, unknownTopic, notice],
      profile,
      "morning",
      now,
      new Set(),
    );
    expect(out.map((s) => s.storyId)).toEqual([good.storyId]);
    expect(selectForDigest([], profile, "morning", now, new Set())).toEqual([]);
  });

  it("uses the first known topic of a story", () => {
    const s = story({ topics: ["cooking", "med", "ai"] });
    expect(selectForDigest([s], profile, "morning", now, new Set())[0]?.topic).toBe("med");
  });

  it("ranks a fresh story above an old one with the same relevance", () => {
    const old = story({ publishedAt: hoursAgo(40) });
    const fresh = story({ publishedAt: hoursAgo(1) });
    const out = selectForDigest([old, fresh], profile, "morning", now, new Set());
    expect(out[0]?.storyId).toBe(fresh.storyId);
  });
});

describe("stories without a topic id", () => {
  it("keeps a safety-exception story under the safety bucket", () => {
    const permit = story({ topics: [], safety: true });
    const out = selectForDigest([permit], profile, "morning", now, new Set());
    expect(out.map((s) => [s.storyId, s.topic])).toEqual([[permit.storyId, "safety"]]);
  });

  it("keeps a scored safety story whose topics match no digest topic", () => {
    const permit = story({ topics: ["books", "cooking"], safety: true });
    const out = selectForDigest([permit], profile, "morning", now, new Set());
    expect(out[0]?.topic).toBe("safety");
  });

  it("puts an unscored fail-open story under the general bucket", () => {
    const open = story({ topics: [], allowGeneral: true });
    const out = selectForDigest([open], profile, "morning", now, new Set());
    expect(out.map((s) => s.topic)).toEqual(["general"]);
  });

  it("still drops a scored story without a matching topic that is not safety", () => {
    const scored = story({ topics: ["cooking"] });
    expect(selectForDigest([scored], profile, "morning", now, new Set())).toEqual([]);
  });

  it("ranks safety stories first, so the digest limit keeps them", () => {
    const wide = profileSchema.parse({
      ...profile,
      topics: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => topic(id, 1)),
    });
    const regular = Array.from({ length: 8 }, (_, i) =>
      story({ topics: [`t${i + 1}`], relevance: 10 }),
    );
    const weakSafety = Array.from({ length: 2 }, () =>
      story({ topics: [], safety: true, relevance: 5, sourceTrust: 1 }),
    );
    const out = selectForDigest([...regular, ...weakSafety], wide, "morning", now, new Set());
    expect(out).toHaveLength(7);
    for (const s of weakSafety) expect(out.map((o) => o.storyId)).toContain(s.storyId);
    expect(out.slice(0, 2).every((s) => s.topic === "safety")).toBe(true);
  });

  it("applies the digest limit to safety stories", () => {
    const many = Array.from({ length: 9 }, () => story({ topics: [], safety: true }));
    expect(selectForDigest(many, profile, "morning", now, new Set())).toHaveLength(7);
    expect(selectForDigest(many, profile, "evening", now, new Set())).toHaveLength(5);
  });

  it("keeps the per-topic limit for normal topics next to safety stories", () => {
    const ai = Array.from({ length: 5 }, () => story({ relevance: 10 }));
    const permit = story({ topics: [], safety: true });
    const out = selectForDigest([...ai, permit], profile, "morning", now, new Set());
    expect(out.filter((s) => s.topic === "ai")).toHaveLength(3);
    expect(out[0]?.storyId).toBe(permit.storyId);
  });
});
