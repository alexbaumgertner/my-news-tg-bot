import { Api } from "grammy";
import type { MessageSender } from "./run.js";

/** Sends Telegram HTML messages with grammY. Link previews are off, so a digest stays compact. */
export function createGrammySender(token: string): MessageSender {
  const api = new Api(token);
  return {
    async send(chatId, html) {
      const message = await api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return message.message_id;
    },
  };
}
