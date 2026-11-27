import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "deploy");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");

/** Return the value of the first `key=` line, or undefined. */
function get(unit: string, key: string): string | undefined {
  const line = unit.split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

const hasSystemd = spawnSync("systemd-analyze", ["--version"]).status === 0;

describe("systemd units", () => {
  it("keeps the bot service restarting on failure", () => {
    const u = read("my-news-tg-bot.service");
    expect(get(u, "Restart")).toBe("on-failure");
    expect(get(u, "StartLimitIntervalSec")).toBe("0");
    expect(get(u, "WantedBy")).toBe("multi-user.target");
  });

  for (const name of ["newsbot-pipeline.service", "newsbot-digest@.service"]) {
    it(`${name} is a safe oneshot`, () => {
      const u = read(name);
      expect(get(u, "Type")).toBe("oneshot");
      expect(get(u, "Restart")).toBe("no");
      expect(get(u, "TimeoutStartSec")).toBeTruthy();
      expect(get(u, "User")).toBe("newsbot");
      expect(get(u, "WorkingDirectory")).toBe("/opt/my-news-tg-bot");
      expect(get(u, "EnvironmentFile")).toBe("/etc/my-news-tg-bot.env");
      expect(get(u, "ExecStart")).toContain("flock");
      expect(get(u, "ExecStart")).toContain("/var/lib/newsbot/pipeline.lock");
    });
  }

  it("limits a pipeline run to under 15 minutes", () => {
    expect(get(read("newsbot-pipeline.service"), "TimeoutStartSec")).toBe("14min");
  });

  it("runs the pipeline every 2 hours in the Istanbul time zone", () => {
    const t = read("newsbot-pipeline.timer");
    expect(get(t, "OnCalendar")).toBe("*-*-* 00/2:00:00 Europe/Istanbul");
    expect(get(t, "Persistent")).toBe("true");
    expect(get(t, "RandomizedDelaySec")).toBe("0");
  });

  for (const [slot, time] of [
    ["morning", "07:30"],
    ["evening", "20:30"],
  ] as const) {
    it(`schedules the ${slot} digest at ${time}`, () => {
      const t = read(`newsbot-digest-${slot}.timer`);
      expect(get(t, "OnCalendar")).toBe(`*-*-* ${time}:00 Europe/Istanbul`);
      expect(get(t, "Persistent")).toBe("true");
      expect(get(t, "RandomizedDelaySec")).toBe("0");
      expect(get(t, "Unit")).toBe(`newsbot-digest@${slot}.service`);
      expect(get(t, "WantedBy")).toBe("timers.target");
    });
  }

  it("passes the slot to the digest command", () => {
    expect(get(read("newsbot-digest@.service"), "ExecStart")).toContain("dist/digest.js --slot %i");
  });

  it("has a valid pipeline script", () => {
    const r = spawnSync("bash", ["-n", join(DIR, "run-pipeline.sh")]);
    expect(r.status).toBe(0);
  });

  it.skipIf(!hasSystemd)("accepts every OnCalendar value", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".timer") && n.includes("digest"))) {
      const spec = get(read(f), "OnCalendar") as string;
      const r = spawnSync("systemd-analyze", ["calendar", spec]);
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });
});
