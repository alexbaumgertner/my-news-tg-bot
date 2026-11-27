import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Profile } from "../profile.js";

export const IMPACTS = ["work", "project", "learning", "health", "life"] as const;
export const STUDY_TYPES = [
  "rct",
  "meta_analysis",
  "systematic_review",
  "cohort",
  "case_control",
  "observational",
  "preclinical",
  "preprint",
  "other",
] as const;

/** The strict JSON that the model returns for one story. Unknown keys are an error. */
export const scoreSchema = z
  .object({
    topics: z.array(z.string().min(1)).max(10),
    relevance: z.number().int().min(0).max(10),
    impact: z.enum(IMPACTS),
    why_me: z.string().trim().min(1).max(600),
    novelty: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    is_russia_domestic: z.boolean(),
    study_type: z.enum(STUDY_TYPES).nullable(),
  })
  .strict();

export type StoryScore = z.infer<typeof scoreSchema>;

export type ParsedScore = { ok: true; score: StoryScore } | { ok: false; error: string };

/**
 * Validate the model answer. Accept one JSON object, with or without a code fence.
 * Reject unknown topic ids. Never repair or guess a value.
 */
export function parseScore(text: string, topicIds: ReadonlySet<string>): ParsedScore {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let data: unknown;
  try {
    data = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    return { ok: false, error: "Output is not valid JSON" };
  }
  const result = scoreSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  const unknown = result.data.topics.filter((topic) => !topicIds.has(topic));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown topic ids: ${unknown.join(", ")}` };
  }
  return { ok: true, score: result.data };
}

export interface ScorePrompt {
  /** The prompt text and the profile. This is the cached system block. */
  system: string;
  /** A short hash of the prompt file. It labels each stored score. */
  version: string;
}

const PROMPT_URL = new URL("../../prompts/score.md", import.meta.url);

/** Render the profile for the model. Topic ids come first, because the output uses them. */
export function renderProfile(profile: Profile): string {
  const topics = profile.topics
    .map(
      (t) =>
        `- id: ${t.id}\n  title: ${t.title}\n  weight: ${t.weight}\n  mode: ${t.mode}\n  description: ${t.description.trim()}`,
    )
    .join("\n");
  return [
    "# Reader profile",
    `About the reader: ${profile.about_me.trim()}`,
    `Hard exclusions: ${profile.hard_exclusions.description.trim()}`,
    `Safety exception: ${profile.safety_exception.description.trim()}`,
    "Topics:",
    topics,
  ].join("\n");
}

/** Build the system block from `prompts/score.md` and the profile. */
export function buildScorePrompt(profile: Profile, promptText?: string): ScorePrompt {
  const prompt = promptText ?? readFileSync(PROMPT_URL, "utf8");
  const version = `score-${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
  return { system: `${prompt.trim()}\n\n${renderProfile(profile)}`, version };
}

/** The user message for one story. The text is cut to `maxChars` characters. */
export function renderStory(title: string, text: string | null, maxChars: number): string {
  const body = (text ?? "").slice(0, maxChars);
  return `<story>\n<title>${title}</title>\n<text>${body}</text>\n</story>`;
}
