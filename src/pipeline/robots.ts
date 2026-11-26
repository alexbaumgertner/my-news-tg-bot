export interface RobotsOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long (ms) a transient failure stays cached. Default: 5 minutes. */
  failureTtlMs?: number;
  /** Clock in ms. Inject it in tests. */
  now?: () => number;
}

const MAX_ROBOTS_BYTES = 500_000;

/** Read a body up to `maxBytes`. Cancel the stream when the limit is reached. */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return out + decoder.decode();
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

interface Loaded {
  rules: Rules | null;
  /** True after a 5xx response, a network error or a timeout. */
  transient: boolean;
}

interface Entry {
  pending: Promise<Loaded>;
  /** Time (ms) when the entry expires. Null means it never expires. */
  expiresAt: number | null;
}

const DEFAULT_FAILURE_TTL_MS = 5 * 60_000;

/**
 * Fetch and cache robots.txt once per origin. A missing file allows all.
 * A transient failure is cached for a short time only. Then the next check retries.
 */
export class RobotsCache {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly options: RobotsOptions) {}

  async isAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const now = (this.options.now ?? Date.now)();
    let entry = this.cache.get(parsed.origin);
    if (!entry || (entry.expiresAt !== null && now >= entry.expiresAt)) {
      const pending = this.load(parsed.origin);
      entry = { pending, expiresAt: null };
      this.cache.set(parsed.origin, entry);
      const created = entry;
      const ttl = this.options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
      void pending.then((loaded) => {
        if (loaded.transient) created.expiresAt = (this.options.now ?? Date.now)() + ttl;
      });
    }
    const { rules } = await entry.pending;
    return rules ? isPathAllowed(rules, parsed.pathname + parsed.search) : true;
  }

  private async load(origin: string): Promise<Loaded> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${origin}/robots.txt`, {
        headers: { "User-Agent": this.options.userAgent },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: "follow",
      });
      if (response.status >= 500) {
        await response.body?.cancel();
        return { rules: { disallow: ["/"], allow: [] }, transient: true };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { rules: null, transient: false };
      }
      const body = await readCappedText(response, MAX_ROBOTS_BYTES);
      return { rules: parseRobots(body, this.options.userAgent), transient: false };
    } catch {
      return { rules: null, transient: true };
    }
  }
}
