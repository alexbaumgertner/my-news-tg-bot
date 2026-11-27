import type { ComposedItem } from "../llm/compose.js";
import type { DigestLanguage } from "../llm/compose-schema.js";
import type { DigestKind } from "../pipeline/rank.js";
import type { Profile } from "../profile.js";

/** Telegram's limit for the text of one message. */
export const TELEGRAM_LIMIT = 4096;

export interface DigestInput {
  kind: DigestKind;
  language: DigestLanguage;
  /** Items in rank order. */
  items: ComposedItem[];
  profile: Profile;
  /** Used for the date in the header. */
  now: Date;
  timeZone: string;
  /** Counts for the footer. Omit to skip the footer. */
  filteredOut?: { items: number; sources: number };
  /** Test hook. Default: the Telegram limit. */
  limit?: number;
}

export interface FormattedDigest {
  /** Telegram HTML messages. Each one fits the limit. Empty when `items` is empty. */
  messages: string[];
  /** Items that the messages contain. */
  shown: ComposedItem[];
  /** Items left out because the URL is not a valid http or https URL. */
  droppedInvalidUrl: number;
}

const STUDY_TYPE_LABELS: Record<DigestLanguage, Record<string, string>> = {
  en: {
    rct: "RCT",
    meta_analysis: "meta-analysis",
    systematic_review: "systematic review",
    cohort: "cohort study",
    case_control: "case-control study",
    observational: "observational study",
    preclinical: "preclinical",
    preprint: "preprint",
    other: "study",
  },
  ru: {
    rct: "РКИ",
    meta_analysis: "метаанализ",
    systematic_review: "систематический обзор",
    cohort: "когортное исследование",
    case_control: "исследование «случай-контроль»",
    observational: "наблюдательное исследование",
    preclinical: "доклиническое исследование",
    preprint: "препринт",
    other: "исследование",
  },
};

interface Labels {
  morning: string;
  evening: string;
  why: string;
  quiet: (count: number) => string;
  nothing: string;
  count: (count: number) => string;
  filtered: (items: number, sources: number) => string;
  degraded: string;
  locale: string;
}

const ruItems = new Intl.PluralRules("ru");

const LABELS: Record<DigestLanguage, Labels> = {
  en: {
    morning: "☀️ Morning",
    evening: "🌙 Evening",
    why: "Why it matters to you",
    quiet: (n) => `Quiet day, ${n} ${n === 1 ? "item" : "items"}`,
    nothing: "Nothing important today.",
    count: (n) => `${n} ${n === 1 ? "item" : "items"}`,
    filtered: (i, s) => `Filtered out: ${i} items from ${s} sources.`,
    degraded:
      "⚠️ Degraded digest: the language model is unavailable or over budget today. Headlines and links only, with no summaries.",
    locale: "en-GB",
  },
  ru: {
    morning: "☀️ Утро",
    evening: "🌙 Вечер",
    why: "Почему это важно для вас",
    quiet: (n) => `Тихий день, ${ruNews(n)}`,
    nothing: "Ничего важного сегодня.",
    count: (n) => ruNews(n),
    filtered: (i, s) => `Отфильтровано: ${i} материалов из ${s} источников.`,
    degraded:
      "⚠️ Упрощённый дайджест: языковая модель сегодня недоступна или бюджет исчерпан. Только заголовки и ссылки, без пересказов.",
    locale: "ru-RU",
  },
};

function ruNews(n: number): string {
  const form = ruItems.select(n);
  const word = form === "one" ? "новость" : form === "few" ? "новости" : "новостей";
  return `${n} ${word}`;
}

/** Escape text for Telegram HTML: `&`, `<` and `>` (Bot API, "HTML style"). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for a double-quoted `href` attribute. */
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/** The URL as a normalized string when it is a valid http or https URL. Otherwise null. */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatItem(item: ComposedItem, number: number, language: DigestLanguage, url: string) {
  const labels = LABELS[language];
  const studyLabel = item.studyType
    ? (STUDY_TYPE_LABELS[language][item.studyType] ?? STUDY_TYPE_LABELS[language].other)
    : null;
  const tag = studyLabel ? ` [${escapeHtml(studyLabel)}]` : "";
  return [
    `${number}. <b>${escapeHtml(item.headline)}</b>${tag}`,
    escapeHtml(item.summary),
    `→ ${labels.why}: ${escapeHtml(item.whyMe)}`,
    `🔗 <a href="${escapeAttr(url)}">${escapeHtml(item.sourceName)}</a> · ${escapeHtml(item.sourceLanguage.toUpperCase())}`,
  ].join("\n");
}

/**
 * Pack the item texts of one topic into blocks that fit the limit. The header starts the first
 * block. An item is never cut. Each item is far shorter than the limit (the schema caps it).
 */
function packTopic(header: string, items: string[], limit: number): string[] {
  const blocks: string[] = [];
  let current = header;
  let hasItem = false;
  for (const item of items) {
    const next = `${current}${hasItem ? "\n\n" : "\n"}${item}`;
    if (next.length > limit && hasItem) {
      blocks.push(current);
      current = item;
    } else {
      current = next;
    }
    hasItem = true;
  }
  blocks.push(current);
  return blocks;
}

/**
 * Format a digest as Telegram HTML messages.
 * - Items are grouped by topic, in profile order. Empty topics are hidden.
 * - A message never exceeds the limit. A split happens between topics, and between items only
 *   when one topic is too long for a message.
 * - An item whose URL is not a valid http or https URL is dropped.
 */
export function formatDigest(input: DigestInput): FormattedDigest {
  const limit = input.limit ?? TELEGRAM_LIMIT;

  const valid: { item: ComposedItem; url: string }[] = [];
  for (const item of input.items) {
    const url = safeUrl(item.url);
    if (url) valid.push({ item, url });
  }
  const droppedInvalidUrl = input.items.length - valid.length;
  if (valid.length === 0) return { messages: [], shown: [], droppedInvalidUrl };

  // Group by topic in profile order. A topic that is not in the profile goes last.
  const order = new Map(input.profile.topics.map((t, i) => [t.id, i]));
  const groups = new Map<string, typeof valid>();
  for (const entry of valid) {
    const list = groups.get(entry.item.topic) ?? [];
    list.push(entry);
    groups.set(entry.item.topic, list);
  }
  const topicIds = [...groups.keys()].sort(
    (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
  );

  const shown: ComposedItem[] = [];
  const blocks: string[] = [];
  let number = 0;
  for (const topicId of topicIds) {
    const topic = input.profile.topics.find((t) => t.id === topicId);
    const header = `${escapeHtml(topic?.emoji ?? "📰")} <b>${escapeHtml(topic?.title ?? topicId)}</b>`;
    const texts: string[] = [];
    for (const { item, url } of groups.get(topicId)!) {
      number++;
      shown.push(item);
      texts.push(formatItem(item, number, input.language, url));
    }
    blocks.push(...packTopic(header, texts, limit));
  }

  const head = digestHead(input, shown.length);
  const footer = filteredFooter(input);

  // Pack the head, the blocks and the footer into messages.
  const units = [head, ...blocks];
  if (footer) units.push(footer);
  return { messages: packUnits(units, limit), shown, droppedInvalidUrl };
}

type HeadInput = Omit<DigestInput, "items">;

/**
 * The message for a day on which nothing passed the ranking. It is short and never padded.
 * The footer shows the filtered-out counts when they are given.
 */
export function formatEmptyDigest(input: HeadInput): string {
  const labels = LABELS[input.language];
  const title = input.kind === "morning" ? labels.morning : labels.evening;
  const footer = filteredFooter(input);
  return [`${title}, ${headDate(input)}`, labels.nothing, ...(footer ? [footer] : [])].join("\n\n");
}

function headDate(input: HeadInput): string {
  return new Intl.DateTimeFormat(LABELS[input.language].locale, {
    day: "numeric",
    month: "long",
    timeZone: input.timeZone,
  }).format(input.now);
}

function digestHead(input: HeadInput, count: number): string {
  const labels = LABELS[input.language];
  const title = input.kind === "morning" ? labels.morning : labels.evening;
  const summary = count <= 2 ? labels.quiet(count) : labels.count(count);
  return `${title}, ${headDate(input)} · ${summary}`;
}

function filteredFooter(input: HeadInput): string | null {
  return input.filteredOut
    ? LABELS[input.language].filtered(input.filteredOut.items, input.filteredOut.sources)
    : null;
}

function packUnits(units: string[], limit: number): string[] {
  const messages: string[] = [];
  let current = "";
  for (const unit of units) {
    const next = current ? `${current}\n\n${unit}` : unit;
    if (next.length <= limit) {
      current = next;
    } else {
      if (current) messages.push(current);
      current = unit;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** A story for the degraded digest. The headline is the original title. */
export interface DegradedStory {
  storyId: number;
  topic: string;
  title: string;
  url: string;
  sourceName: string;
}

export interface DegradedDigestInput extends Omit<DigestInput, "items"> {
  /** Stories in rank order. */
  stories: DegradedStory[];
}

export interface FormattedDegradedDigest {
  messages: string[];
  shown: DegradedStory[];
  droppedInvalidUrl: number;
}

const MAX_DEGRADED_TITLE_CHARS = 200;

/**
 * Format the degraded digest: a note, then the title and the link of each story, grouped by
 * topic. It has no summaries. A story whose URL is not a valid http or https URL is dropped.
 */
export function formatDegradedDigest(input: DegradedDigestInput): FormattedDegradedDigest {
  const limit = input.limit ?? TELEGRAM_LIMIT;
  const valid: { story: DegradedStory; url: string }[] = [];
  for (const story of input.stories) {
    const url = safeUrl(story.url);
    if (url) valid.push({ story, url });
  }
  const droppedInvalidUrl = input.stories.length - valid.length;
  if (valid.length === 0) return { messages: [], shown: [], droppedInvalidUrl };

  const order = new Map(input.profile.topics.map((t, i) => [t.id, i]));
  const groups = new Map<string, typeof valid>();
  for (const entry of valid) {
    const list = groups.get(entry.story.topic) ?? [];
    list.push(entry);
    groups.set(entry.story.topic, list);
  }
  const topicIds = [...groups.keys()].sort(
    (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
  );

  const shown: DegradedStory[] = [];
  const blocks: string[] = [];
  let number = 0;
  for (const topicId of topicIds) {
    const topic = input.profile.topics.find((t) => t.id === topicId);
    const header = `${escapeHtml(topic?.emoji ?? "📰")} <b>${escapeHtml(topic?.title ?? topicId)}</b>`;
    const texts: string[] = [];
    for (const { story, url } of groups.get(topicId)!) {
      number++;
      shown.push(story);
      // The title comes from a remote source. Cap its length so that a message stays small.
      const title = story.title.slice(0, MAX_DEGRADED_TITLE_CHARS);
      texts.push(
        `${number}. <a href="${escapeAttr(url)}">${escapeHtml(title)}</a> · ${escapeHtml(story.sourceName)}`,
      );
    }
    blocks.push(...packTopic(header, texts, limit));
  }

  const units = [digestHead(input, shown.length), LABELS[input.language].degraded, ...blocks];
  const footer = filteredFooter(input);
  if (footer) units.push(footer);
  return { messages: packUnits(units, limit), shown, droppedInvalidUrl };
}
