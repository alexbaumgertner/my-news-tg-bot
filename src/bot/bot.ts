import { Bot } from "grammy";
import type { BotCommand } from "grammy/types";
import type { Db } from "../db/client.js";
import { parseFeedback } from "../feedback/callback.js";
import { createDbFeedbackStore, type FeedbackStore } from "../feedback/store.js";
import { DEFAULT_FEEDBACK_CONFIG, type FeedbackConfig } from "../feedback/rules.js";
import { parseLanguage, parseSchedule } from "./parse.js";
import { getSettings, updateSettings } from "./settings.js";

export const COMMANDS: BotCommand[] = [
  { command: "start", description: "Bind this chat" },
  { command: "digest", description: "Build a digest now" },
  { command: "lang", description: "Set output language: ru or en" },
  { command: "schedule", description: "Show or set digest times" },
];

export interface BotDeps {
  token: string;
  ownerId: number;
  db: Db;
  /** Build and send a digest now. Not available until the digest task is done. */
  /** Bounds of the feedback multipliers. Default: the defaults of `FEEDBACK_*`. */
  feedback?: FeedbackConfig;
  /** Stores votes. Default: on `db`. Tests may pass a fake. */
  feedbackStore?: FeedbackStore;
  buildDigest?: (userId: number, chatId: number) => Promise<void>;
}

export function createBot(deps: BotDeps): Bot {
  const { ownerId, db } = deps;
  const bot = new Bot(deps.token);

  // Whitelist: drop every update that does not come from the owner. No reply.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return;
    await next();
  });

  bot.command("start", async (ctx) => {
    await updateSettings(db, ownerId, { chatId: ctx.chat.id });
    await ctx.reply(
      "Ready. Commands: /digest, /lang ru|en, /schedule. Use /schedule morning 07:30 to set a time.",
    );
  });

  bot.command("digest", async (ctx) => {
    if (!deps.buildDigest) {
      await ctx.reply("The digest builder is not available yet.");
      return;
    }
    await ctx.reply("Building the digest…");
    try {
      await deps.buildDigest(ownerId, ctx.chat.id);
    } catch (error) {
      console.error("digest failed", error);
      await ctx.reply("The digest failed. See the logs.");
    }
  });

  bot.command("lang", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      const settings = await getSettings(db, ownerId);
      await ctx.reply(`Language: ${settings.language}. Use /lang ru or /lang en.`);
      return;
    }
    const language = parseLanguage(arg);
    if (!language) {
      await ctx.reply("Use /lang ru or /lang en.");
      return;
    }
    await updateSettings(db, ownerId, { language });
    await ctx.reply(`Language set to ${language}.`);
  });

  bot.command("schedule", async (ctx) => {
    const arg = ctx.match.trim();
    if (arg) {
      const parsed = parseSchedule(arg);
      if (!parsed) {
        await ctx.reply("Use /schedule morning HH:MM or /schedule evening HH:MM.");
        return;
      }
      await updateSettings(
        db,
        ownerId,
        parsed.slot === "morning" ? { morningTime: parsed.time } : { eveningTime: parsed.time },
      );
    }
    const s = await getSettings(db, ownerId);
    await ctx.reply(
      `Morning: ${s.morningTime}\nEvening: ${s.eveningTime}\nTime zone: ${s.timezone}`,
    );
  });

  const feedbackStore =
    deps.feedbackStore ?? createDbFeedbackStore(db, deps.feedback ?? DEFAULT_FEEDBACK_CONFIG);

  // Feedback buttons. The whitelist above already drops a press from anyone but the owner.
  bot.on("callback_query:data", async (ctx) => {
    const action = parseFeedback(ctx.callbackQuery.data);
    if (!action) {
      // Not a feedback button. Answer so that the client stops the spinner.
      await ctx.answerCallbackQuery();
      return;
    }
    let text: string;
    try {
      const outcome = await feedbackStore.press(ownerId, action);
      if (outcome.status === "not_found") text = "This item is no longer available.";
      else if (outcome.vote === "up") text = "👍 Noted";
      else if (outcome.vote === "down") text = "👎 Noted";
      else text = "Vote removed";
    } catch (error) {
      console.error("feedback failed", error);
      text = "Could not save the vote. Try again.";
    }
    await ctx.answerCallbackQuery({ text });
  });

  return bot;
}

/** Register the command list with the Bot API, then start long polling. */
export async function startBot(bot: Bot, onStart: () => void): Promise<void> {
  await bot.api.setMyCommands(COMMANDS);
  await bot.start({ onStart });
}
