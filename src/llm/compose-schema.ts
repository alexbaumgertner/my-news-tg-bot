import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Profile } from "../profile.js";
import { renderProfile, type ScorePrompt } from "./score-schema.js";

/** Digest languages. `mixed` is not supported yet: it needs the English block (SPEC section 6). */
export const DIGEST_LANGUAGES = ["en", "ru"] as const;
export type DigestLanguage = (typeof DIGEST_LANGUAGES)[number];

/** The strict JSON that the model returns for one item. Unknown keys are an error. */
export const composeSchema = z
  .object({
    headline: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1200),
    why_me: z.string().trim().min(1).max(400),
  })
  .strict();

export type ComposedText = z.infer<typeof composeSchema>;

export type ParsedCompose = { ok: true; text: ComposedText } | { ok: false; error: string };

/** Validate the model answer. Accept one JSON object, with or without a code fence. */
export function parseCompose(text: string): ParsedCompose {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let data: unknown;
  try {
    data = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    return { ok: false, error: "Output is not valid JSON" };
  }
  const result = composeSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { ok: true, text: result.data };
}

const PROMPT_URL = new URL("../../prompts/compose.md", import.meta.url);

/** Build the system block from `prompts/compose.md` and the profile. */
export function buildComposePrompt(profile: Profile, promptText?: string): ScorePrompt {
  const prompt = promptText ?? readFileSync(PROMPT_URL, "utf8");
  const version = `compose-${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
  return { system: `${prompt.trim()}\n\n${renderProfile(profile)}`, version };
}

/** What the composer needs to know about one story. */
export interface ComposeStory {
  storyId: number;
  title: string;
  /** Item text. It can be empty. */
  text: string | null;
  url: string;
  sourceName: string;
  /** Language code of the source, for example "en", "ru" or "de". */
  sourceLanguage: string;
  /** Topic id that sets the group in the digest. */
  topic: string;
  /** From the scoring step. Null for items that are not science. */
  studyType: string | null;
  /** The `why_me` sentence from the scoring step. It is a hint. */
  whyMeHint: string | null;
}

/** Remove the tags that could close the story block early. */
function neutralize(value: string): string {
  return value.replace(
    /<\/?(story|title|source|source_language|study_type|scoring_note|text)\b[^>]*>/gi,
    "",
  );
}

/** The user message for one story. The text is cut to `maxChars` characters. */
export function renderComposeStory(
  story: ComposeStory,
  language: DigestLanguage,
  maxChars: number,
): string {
  const body = neutralize((story.text ?? "").slice(0, maxChars));
  const parts = [
    `<output_language>${language}</output_language>`,
    "<story>",
    `<title>${neutralize(story.title)}</title>`,
    `<source>${neutralize(story.sourceName)}</source>`,
    `<source_language>${neutralize(story.sourceLanguage)}</source_language>`,
  ];
  if (story.studyType) parts.push(`<study_type>${neutralize(story.studyType)}</study_type>`);
  if (story.whyMeHint) parts.push(`<scoring_note>${neutralize(story.whyMeHint)}</scoring_note>`);
  parts.push(`<text>${body}</text>`, "</story>");
  return parts.join("\n");
}
