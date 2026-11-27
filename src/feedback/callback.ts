import type { InlineKeyboardMarkup } from "grammy/types";
import type { Vote } from "./rules.js";

/** What a feedback button carries. The rest is looked up in the database. */
export interface FeedbackAction {
  digestId: number;
  /** Position of the item in the digest. It is the number that the message shows. */
  position: number;
  vote: Vote;
}

const PREFIX = "f";
const PATTERN = /^f:(\d{1,15}):(\d{1,3}):([ud])$/;

/** `callback_data` of a button: `f:<digest id>:<position>:<u|d>`. At most 25 bytes. */
export function encodeFeedback(action: FeedbackAction): string {
  return `${PREFIX}:${action.digestId}:${action.position}:${action.vote === "up" ? "u" : "d"}`;
}

/** Parse `callback_data`. Null for anything that is not a valid feedback payload. */
export function parseFeedback(data: string): FeedbackAction | null {
  const match = PATTERN.exec(data);
  if (!match) return null;
  const digestId = Number(match[1]);
  const position = Number(match[2]);
  if (!Number.isSafeInteger(digestId) || digestId < 1 || position < 1) return null;
  return { digestId, position, vote: match[3] === "u" ? "up" : "down" };
}

/** One row per item, with a 👍 and a 👎 button. The label carries the item number. */
export function feedbackKeyboard(digestId: number, positions: number[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: positions.map((position) => [
      { text: `👍 ${position}`, callback_data: encodeFeedback({ digestId, position, vote: "up" }) },
      {
        text: `👎 ${position}`,
        callback_data: encodeFeedback({ digestId, position, vote: "down" }),
      },
    ]),
  };
}
