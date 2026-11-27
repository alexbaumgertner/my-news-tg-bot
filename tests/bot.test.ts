import { describe, expect, it } from "vitest";
import { COMMANDS, createBot } from "../src/bot/bot.js";
import { parseLanguage, parseSchedule, parseTime } from "../src/bot/parse.js";

describe("parse", () => {
  it("parses languages", () => {
    expect(parseLanguage(" RU ")).toBe("ru");
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("mixed")).toBeNull();
    expect(parseLanguage("")).toBeNull();
  });

  it("parses times", () => {
    expect(parseTime("7:30")).toBe("07:30");
    expect(parseTime("20:30")).toBe("20:30");
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("abc")).toBeNull();
  });

  it("parses schedule arguments", () => {
    expect(parseSchedule("morning 8:05")).toEqual({ slot: "morning", time: "08:05" });
    expect(parseSchedule("Evening 21:00")).toEqual({ slot: "evening", time: "21:00" });
    expect(parseSchedule("noon 12:00")).toBeNull();
    expect(parseSchedule("morning")).toBeNull();
  });
});

describe("commands", () => {
  it("lists the four MVP commands", () => {
    expect(COMMANDS.map((c) => c.command)).toEqual(["start", "digest", "lang", "schedule"]);
  });
});

describe("whitelist", () => {
  function setup() {
    const calls: string[] = [];
    const bot = createBot({ token: "123:abc", ownerId: 1, db: {} as never });
    bot.botInfo = { id: 123, is_bot: true, first_name: "t", username: "t_bot" } as never;
    bot.api.config.use((_prev, method) => {
      calls.push(method);
      return Promise.resolve({ ok: true, result: true } as never);
    });
    const update = (fromId: number) => ({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: fromId, type: "private" as const, first_name: "x" },
        from: { id: fromId, is_bot: false, first_name: "x" },
        text: "/digest",
        entities: [{ type: "bot_command" as const, offset: 0, length: 7 }],
      },
    });
    return { bot, calls, update };
  }

  it("ignores other users silently", async () => {
    const { bot, calls, update } = setup();
    await bot.handleUpdate(update(2));
    expect(calls).toEqual([]);
  });

  it("answers the owner", async () => {
    const { bot, calls, update } = setup();
    await bot.handleUpdate(update(1));
    expect(calls).toEqual(["sendMessage"]);
  });
});
