import { parse } from "csv-parse/sync";
import { z } from "zod";

export const MIN_PER_LABEL = 25;
const MAX_REPORTED_ERRORS = 20;
const TOPIC_ID = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const REQUIRED_COLUMNS = ["id", "label", "topics", "reason"] as const;

/** The error has one message line per invalid row. */
export class GoldenBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenBuildError";
  }
}

const rowSchema = z
  .object({
    id: z.string().trim().min(1, "id is empty"),
    label: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.enum(["keep", "drop"], { error: "label must be keep or drop" }),
    ),
    reason: z.string().trim().min(1, "reason is empty"),
    topics: z.string().transform((value) =>
      value
        .split(";")
        .map((topic) => topic.trim())
        .filter(Boolean),
    ),
  })
  .superRefine((row, ctx) => {
    row.topics.forEach((topic) => {
      if (!TOPIC_ID.test(topic)) {
        ctx.addIssue({
          code: "custom",
          path: ["topics"],
          message: `topic "${topic}" is not a snake_case id`,
        });
      }
    });
    if (row.label === "keep" && row.topics.length === 0) {
      ctx.addIssue({ code: "custom", path: ["topics"], message: "keep needs at least one topic" });
    }
  });

/** One line of `tests/golden/items.jsonl`. */
export interface GoldenItem {
  id: string;
  source: string;
  lang: string;
  title: string;
  url: string;
  published_at: string;
  snippet: string;
  dup_group: number | null;
  label: "keep" | "drop";
  topics: string[];
  reason: string;
}

export interface GoldenBuildResult {
  items: GoldenItem[];
  /** The JSONL text: one object per line, sorted by id. */
  jsonl: string;
  keep: number;
  drop: number;
  warnings: string[];
}

/** Excel in a Russian locale saves with ";" and Numbers may use a tab. Detect it from the header. */
function detectDelimiter(text: string): string {
  for (const delimiter of [",", ";", "\t"]) {
    try {
      const rows: string[][] = parse(text, {
        bom: true,
        delimiter,
        to_line: 1,
        relax_column_count: true,
      });
      if (rows[0]?.some((name) => name.trim() === "label")) return delimiter;
    } catch {
      // The header is not valid with this delimiter. Try the next one.
    }
  }
  return ",";
}

/**
 * Convert the labeled CSV text to JSONL. Skip rows with an empty label.
 * Throw GoldenBuildError with the spreadsheet row number of each invalid row.
 * Row 1 is the header, so the first item is row 2.
 */
export function buildGolden(csvText: string): GoldenBuildResult {
  let records: Record<string, string>[];
  try {
    records = parse(csvText, {
      bom: true,
      columns: (header: string[]) => header.map((name) => name.trim()),
      delimiter: detectDelimiter(csvText),
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new GoldenBuildError(`Cannot read the CSV: ${(error as Error).message}`);
  }
  const first = records[0];
  const columns = first ? Object.keys(first) : [];
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (records.length > 0 && missing.length > 0) {
    throw new GoldenBuildError(`Missing CSV columns: ${missing.join(", ")}`);
  }

  const errors: string[] = [];
  const items: GoldenItem[] = [];
  const seenIds = new Map<string, number>();
  records.forEach((record, index) => {
    const rowNumber = index + 2;
    if (!(record.label ?? "").trim()) return;
    const parsed = rowSchema.safeParse({
      id: record.id ?? "",
      label: record.label,
      reason: record.reason ?? "",
      topics: record.topics ?? "",
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`Row ${rowNumber}: ${issue.message}`);
      }
      return;
    }
    const row = parsed.data;
    const previous = seenIds.get(row.id);
    if (previous !== undefined) {
      errors.push(`Row ${rowNumber}: id ${row.id} is already used in row ${previous}`);
      return;
    }
    seenIds.set(row.id, rowNumber);
    const group = Number((record.dup_group ?? "").trim());
    items.push({
      id: row.id,
      source: record.source ?? "",
      lang: record.lang ?? "",
      title: record.title ?? "",
      url: record.url ?? "",
      published_at: record.published_at ?? "",
      snippet: record.snippet ?? "",
      dup_group: Number.isInteger(group) && group > 0 ? group : null,
      label: row.label,
      topics: row.topics,
      reason: row.reason,
    });
  });

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    const more = errors.length - shown.length;
    throw new GoldenBuildError(
      [...shown, ...(more > 0 ? [`... and ${more} more`] : [])].join("\n"),
    );
  }
  if (items.length === 0) {
    throw new GoldenBuildError("No labeled rows. Fill the label column with keep or drop.");
  }

  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keep = items.filter((item) => item.label === "keep").length;
  const drop = items.length - keep;
  const warnings: string[] = [];
  if (keep < MIN_PER_LABEL) warnings.push(`Only ${keep} keep items. Aim for ${MIN_PER_LABEL}+.`);
  if (drop < MIN_PER_LABEL) warnings.push(`Only ${drop} drop items. Aim for ${MIN_PER_LABEL}+.`);
  return {
    items,
    jsonl: items.map((item) => JSON.stringify(item)).join("\n") + "\n",
    keep,
    drop,
    warnings,
  };
}
