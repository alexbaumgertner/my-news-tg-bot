import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseEnv } from "../src/config.js";

const validEnv = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "123",
  DATABASE_URL: "postgres://localhost/db",
  ANTHROPIC_API_KEY: "key",
  CONFIG_DIR: "./config",
};

describe("config", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = parseEnv(validEnv);
    expect(env.TELEGRAM_OWNER_ID).toBe(123);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("reports every missing variable in a readable error", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
    expect(() => parseEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("loads and validates config/sources.yaml", () => {
    const config = loadConfig(validEnv);
    expect(config.sources.length).toBeGreaterThan(0);
  });
});
