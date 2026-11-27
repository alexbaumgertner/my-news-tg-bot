import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { loadProfile } from "../src/profile.js";

const examplePath = join(import.meta.dirname, "..", "config", "profile.example.yaml");

function writeTemp(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "profile-")), "profile.yaml");
  writeFileSync(path, content);
  return path;
}

function sentences(text: string): number {
  return text.split(/[.!?](?:\s+|$)/).filter((part) => part.trim() !== "").length;
}

describe("example profile", () => {
  const profile = loadProfile(examplePath);

  it("has the 13 topics with unique ids", () => {
    expect(profile.topics).toHaveLength(13);
    expect(new Set(profile.topics.map((t) => t.id)).size).toBe(13);
  });

  it("marks books as notice and the other topics as digest", () => {
    for (const topic of profile.topics) {
      expect(topic.mode).toBe(topic.id === "books" ? "notice" : "digest");
    }
  });

  it("has at least 5 keywords and 2-4 description sentences per topic", () => {
    for (const topic of profile.topics) {
      expect(topic.keywords.length, topic.id).toBeGreaterThanOrEqual(5);
      const count = sentences(topic.description);
      expect(count, topic.id).toBeGreaterThanOrEqual(2);
      expect(count, topic.id).toBeLessThanOrEqual(4);
    }
  });
});

describe("loadProfile errors", () => {
  const valid = `
version: 1
about_me: text
hard_exclusions: { description: d, keywords: [a] }
safety_exception: { description: d, keywords: [a] }
topics:
  - id: sample_topic
    title: T
    weight: 0.5
    description: One. Two.
    keywords: [a, b, c, d, e]
`;

  it("accepts a minimal valid file and defaults mode to digest", () => {
    expect(loadProfile(writeTemp(valid)).topics[0]?.mode).toBe("digest");
  });

  it("fails when a topic field is missing", () => {
    const path = writeTemp(valid.replace("    title: T\n", ""));
    expect(() => loadProfile(path)).toThrow(/topics\.0\.title/);
  });

  it("fails on an unknown field", () => {
    const path = writeTemp(valid + "extra: 1\n");
    expect(() => loadProfile(path)).toThrow(ConfigError);
    expect(() => loadProfile(path)).toThrow(/extra/);
  });

  it("fails on a wrong type or range", () => {
    expect(() => loadProfile(writeTemp(valid.replace("0.5", "high")))).toThrow(/weight/);
    expect(() => loadProfile(writeTemp(valid.replace("0.5", "1.5")))).toThrow(/weight/);
  });

  it("fails on too few keywords", () => {
    const path = writeTemp(valid.replace("[a, b, c, d, e]", "[a, b]"));
    expect(() => loadProfile(path)).toThrow(/at least 5 keywords/);
  });

  it("fails on a bad id and on duplicate ids", () => {
    expect(() => loadProfile(writeTemp(valid.replace("sample_topic", "BadId")))).toThrow(
      /snake_case/,
    );
    const dup = valid + valid.split("topics:\n")[1];
    expect(() => loadProfile(writeTemp(dup))).toThrow(/duplicate topic id/);
  });
});
