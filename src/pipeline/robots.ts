export interface RobotsOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface Rules {
  disallow: string[];
  allow: string[];
}

/** Parse the rules of robots.txt that apply to our agent. The most specific group wins. */
export function parseRobots(body: string, userAgent: string): Rules {
  const product = userAgent.split(/[/\s]/)[0]?.toLowerCase() ?? "";
  const groups: { agents: string[]; rules: Rules }[] = [];
  let current: { agents: string[]; rules: Rules } | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { disallow: [], allow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || !value) continue;
    if (key === "disallow") current.rules.disallow.push(value);
    if (key === "allow") current.rules.allow.push(value);
  }
  const specific = groups.filter((g) => product && g.agents.includes(product));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    disallow: chosen.flatMap((g) => g.rules.disallow),
    allow: chosen.flatMap((g) => g.rules.allow),
  };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/** Check a path against rules. The longest matching rule wins. Allow wins a tie. */
export function isPathAllowed(rules: Rules, path: string): boolean {
  let best = { length: -1, allowed: true };
  for (const p of rules.disallow) {
    if (matches(p, path) && p.length > best.length) best = { length: p.length, allowed: false };
  }
  for (const p of rules.allow) {
    if (matches(p, path) && p.length >= best.length) best = { length: p.length, allowed: true };
  }
  return best.allowed;
}

/** Fetch and cache robots.txt once per origin. A missing or broken file allows all. */
export class RobotsCache {
  private readonly cache = new Map<string, Promise<Rules | null>>();

  constructor(private readonly options: RobotsOptions) {}

  async isAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    let pending = this.cache.get(parsed.origin);
    if (!pending) {
      pending = this.load(parsed.origin);
      this.cache.set(parsed.origin, pending);
    }
    const rules = await pending;
    return rules ? isPathAllowed(rules, parsed.pathname + parsed.search) : true;
  }

  private async load(origin: string): Promise<Rules | null> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${origin}/robots.txt`, {
        headers: { "User-Agent": this.options.userAgent },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: "follow",
      });
      if (response.status >= 500) return { disallow: ["/"], allow: [] };
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return parseRobots((await response.text()).slice(0, 500_000), this.options.userAgent);
    } catch {
      return null;
    }
  }
}
