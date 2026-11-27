import type { InlineKeyboardMarkup } from "grammy/types";
import type { Vote } from "./rules.js";

/**
 * What a feedback button carries: the database id of the digest item and the vote.
 * The id is never reused. A retry of a digest deletes the items of the earlier attempt and
 * creates new rows with new ids, so a button of a replaced attempt matches no row.
 */
export interface FeedbackAction {
  digestItemId: number;
  vote: Vote;
}

const PREFIX = "f";
const PATTERN = /^f:(\d{1,19}):([ud])$/;

/** `callback_data` of a button: `f:<digest item id>:<u|d>`. At most 23 bytes. */
export function encodeFeedback(action: FeedbackAction): string {
  return `${PREFIX}:${action.digestItemId}:${action.vote === "up" ? "u" : "d"}`;
}

/** Parse `callback_data`. Null for anything that is not a valid feedback payload. */
export function parseFeedback(data: string): FeedbackAction | null {
  const match = PATTERN.exec(data);
  if (!match) return null;
  const digestItemId = Number(match[1]);
  if (!Number.isSafeInteger(digestItemId) || digestItemId < 1) return null;
  return { digestItemId, vote: match[2] === "u" ? "up" : "down" };
}

/**
 * One row per item, with a 👍 and a 👎 button. The label carries the item number.
 * `itemIds[position - 1]` is the digest item id of the item at `position`.
 */
export function feedbackKeyboard(positions: number[], itemIds: number[]): InlineKeyboardMarkup {
  const rows = positions.flatMap((position) => {
    const digestItemId = itemIds[position - 1];
    if (digestItemId === undefined) return [];
    return [
      [
        {
          text: `👍 ${position}`,
          callback_data: encodeFeedback({ digestItemId, vote: "up" }),
        },
        {
          text: `👎 ${position}`,
          callback_data: encodeFeedback({ digestItemId, vote: "down" }),
        },
      ],
    ];
  });
  return { inline_keyboard: rows };
}
