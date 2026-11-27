import { z } from "zod";
import { loadYamlFile } from "./config.js";

const keywordList = z.array(z.string().min(1));

const ruleSchema = z
  .object({
    description: z.string().min(1),
    keywords: keywordList.min(1),
  })
  .strict();

export const topicSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, "use snake_case"),
    title: z.string().min(1),
    weight: z.number().min(0).max(1),
    mode: z.enum(["digest", "notice"]).default("digest"),
    description: z.string().min(1),
    keywords: keywordList.min(5, "at least 5 keywords are required"),
    stop_words: keywordList.optional(),
  })
  .strict();

export const profileSchema = z
  .object({
    version: z.literal(1),
    about_me: z.string().min(1),
    hard_exclusions: ruleSchema,
    safety_exception: ruleSchema,
    topics: z.array(topicSchema).min(1),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.topics.forEach((topic, index) => {
      if (seen.has(topic.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["topics", index, "id"],
          message: `duplicate topic id "${topic.id}"`,
        });
      }
      seen.add(topic.id);
    });
  });

export type Topic = z.infer<typeof topicSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** Load and validate a profile file. Throws ConfigError with a clear message. */
export function loadProfile(path: string): Profile {
  return loadYamlFile(path, profileSchema);
}
