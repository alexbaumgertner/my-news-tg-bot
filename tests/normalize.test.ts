import { describe, expect, it, vi } from "vitest";
import {
  Normalizer,
  cleanText,
  detectLanguage,
  extractMainText,
} from "../src/pipeline/normalize.js";
import { RobotsCache, isPathAllowed, parseRobots } from "../src/pipeline/robots.js";
import type { RawItem } from "../src/fetchers/types.js";

const html = `<html><head><title>T</title><link rel="canonical" href="/canonical?utm_source=x"></head>
<body><nav>Menu Menu</nav><article><h1>Big news</h1>
${"<p>The research team published a new result about agentic coding tools and how they change daily work for engineers.</p>".repeat(8)}
</article><footer>Footer</footer></body></html>`;

const userAgent = "test-agent/1.0";

function makeFetch(
  pages: Record<string, { body: string; redirectTo?: string; status?: number }>,
  robotsByOrigin: Record<string, string> = {},
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) {
      const origin = new URL(url).origin;
      return new Response(robotsByOrigin[origin] ?? "User-agent: *\nDisallow: /private\n");
    }
    const page = pages[url];
    if (!page) return new Response("nope", { status: 404 });
    if (page.redirectTo) {
      return new Response(null, { status: 302, headers: { location: page.redirectTo } });
    }
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

const raw = (over: Partial<RawItem> = {}): RawItem => ({
  url: "https://example.com/a?utm_source=rss",
  title: "Big news",
  text: null,
  publishedAt: null,
  language: "en",
  ...over,
});

describe("helpers", () => {
  it("detects language and falls back for short text", () => {
    expect(
      detectLanguage("The quick brown fox jumps over the lazy dog near the river bank", "ru"),
    ).toBe("en");
    expect(
      detectLanguage("Быстрая коричневая лиса перепрыгивает через ленивую собаку у реки", "en"),
    ).toBe("ru");
    expect(detectLanguage("Hi", "tr")).toBe("tr");
  });

  it("cleans HTML and caps length", () => {
    expect(cleanText("<p>Hello&nbsp;<b>world</b></p><script>x()</script>", 100)).toBe(
      "Hello world",
    );
    expect(cleanText("a".repeat(50), 10)).toHaveLength(10);
  });

  it("keeps literal markup in the article text", () => {
    const body = `<html><body><article><h1>Dialogs</h1><p>${"Use &lt;dialog&gt; rather than &lt;div&gt; for this component, and avoid inline code. ".repeat(6)}</p><p>Example: &lt;script&gt;alert(1)&lt;/script&gt; is shown as text in this long enough paragraph about web components.</p></article></body></html>`;
    const result = extractMainText(body, "https://example.com/a", 5_000);
    expect(result.text).toContain("Use <dialog> rather than <div> for this component");
    expect(result.text).toContain("<script>alert(1)</script>");
  });

  it("extracts main text and canonical link", () => {
    const result = extractMainText(html, "https://example.com/a", 300);
    expect(result.text).toContain("agentic coding");
    expect(result.text).not.toContain("Footer");
    expect(result.text!.length).toBeLessThanOrEqual(300);
    expect(result.canonicalLink).toBe("https://example.com/canonical?utm_source=x");
  });
});

describe("robots", () => {
  it("applies the most specific rule", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /private\nAllow: /private/open\n",
      userAgent,
    );
    expect(isPathAllowed(rules, "/private/x")).toBe(false);
    expect(isPathAllowed(rules, "/private/open/x")).toBe(true);
    expect(isPathAllowed(rules, "/public")).toBe(true);
  });

  it("decodes percent-encoded unreserved characters before matching", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\n", userAgent);
    expect(isPathAllowed(rules, "/%70rivate/news")).toBe(false);
  });

  it("matches non-ASCII rule paths against encoded URLs", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /café\n", userAgent);
    expect(isPathAllowed(rules, "/caf%C3%A9/news")).toBe(false);
    expect(isPathAllowed(rules, "/caf%c3%a9/news")).toBe(false);
  });

  it("does not decode encoded reserved characters", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /a/b\n", userAgent);
    expect(isPathAllowed(rules, "/a%2Fb")).toBe(true);
    expect(isPathAllowed(rules, "/a%2fb")).toBe(true);
    const encodedRule = parseRobots("User-agent: *\nDisallow: /a%2Fb\n", userAgent);
    expect(isPathAllowed(encodedRule, "/a%2fb")).toBe(false);
    expect(isPathAllowed(encodedRule, "/a/b")).toBe(true);
  });
});

describe("RobotsCache", () => {
  it("cancels an oversized robots.txt stream early", async () => {
    const chunk = new TextEncoder().encode("# comment\n".repeat(10_000));
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) return controller.close();
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    const cache = new RobotsCache({ userAgent, fetchImpl });
    expect(await cache.isAllowed("https://example.com/x")).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it("denies the origin when robots.txt cannot be fetched, then retries after the TTL", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new TypeError("fetch failed");
      return new Response("User-agent: *\nAllow: /\n");
    }) as unknown as typeof fetch;
    let time = 0;
    const cache = new RobotsCache({ userAgent, fetchImpl, failureTtlMs: 1_000, now: () => time });
    expect(await cache.isAllowed("https://example.com/x")).toBe(false);
    fail = false;
    time = 500;
    expect(await cache.isAllowed("https://example.com/x")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 1_500;
    expect(await cache.isAllowed("https://example.com/x")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not request the page when robots.txt fetch rejects", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/robots.txt")) throw new TypeError("fetch failed");
      return new Response(html, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const n = new Normalizer({ userAgent, fetchImpl });
    const [item] = await n.normalizeAll([raw({ text: "short snippet" })]);
    expect(item!.text).toBe("short snippet");
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.endsWith("/robots.txt"))).toBe(true);
  });

  it("retries a transient robots.txt failure after the TTL", async () => {
    let status = 503;
    const fetchImpl = vi.fn(async () =>
      status === 503
        ? new Response("", { status: 503 })
        : new Response("User-agent: *\nAllow: /\n"),
    ) as unknown as typeof fetch;
    let time = 0;
    const cache = new RobotsCache({
      userAgent,
      fetchImpl,
      failureTtlMs: 1_000,
      now: () => time,
    });
    expect(await cache.isAllowed("https://example.com/x")).toBe(false);
    status = 200;
    time = 500;
    expect(await cache.isAllowed("https://example.com/x")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 1_500;
    expect(await cache.isAllowed("https://example.com/x")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time = 10_000_000;
    expect(await cache.isAllowed("https://example.com/y")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Normalizer", () => {
  it("fetches the page for a snippet, follows the redirect and canonicalizes", async () => {
    const fetchImpl = makeFetch({
      "https://example.com/a?utm_source=rss": { body: "", redirectTo: "https://example.com/real" },
      "https://example.com/real": { body: html },
    });
    const n = new Normalizer({ userAgent, fetchImpl });
    const [item] = await n.normalizeAll([raw({ text: "short snippet" })]);
    expect(item!.text).toContain("agentic coding");
    expect(item!.language).toBe("en");
    expect(item!.canonicalUrl).toBe("https://example.com/canonical");
    expect(item!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips the fetch when the feed has the full text", async () => {
    const fetchImpl = makeFetch({});
    const n = new Normalizer({ userAgent, fetchImpl });
    const long = "Это длинный текст новости про искусственный интеллект. ".repeat(20);
    const [item] = await n.normalizeAll([raw({ text: long, language: "en" })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(item!.language).toBe("ru");
    expect(item!.canonicalUrl).toBe("https://example.com/a");
  });

  it("respects robots.txt and keeps the snippet when the page fails", async () => {
    const fetchImpl = makeFetch({});
    const n = new Normalizer({ userAgent, fetchImpl });
    const [item] = await n.normalizeAll([
      raw({ url: "https://example.com/private/x", text: "snippet text here" }),
    ]);
    expect(item!.text).toBe("snippet text here");
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  const fetched = (f: typeof fetch) =>
    (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

  it("does not fetch a redirect into a disallowed path", async () => {
    const fetchImpl = makeFetch({
      "https://example.com/out": { body: "", redirectTo: "https://example.com/private/article" },
      "https://example.com/private/article": { body: html },
    });
    const n = new Normalizer({ userAgent, fetchImpl });
    const [item] = await n.normalizeAll([
      raw({ url: "https://example.com/out", text: "snippet text here" }),
    ]);
    expect(item!.text).toBe("snippet text here");
    expect(fetched(fetchImpl)).not.toContain("https://example.com/private/article");
  });

  it("does not fetch a redirect into another origin that disallows it", async () => {
    const fetchImpl = makeFetch(
      {
        "https://example.com/out": { body: "", redirectTo: "https://other.example/page" },
        "https://other.example/page": { body: html },
      },
      { "https://other.example": "User-agent: *\nDisallow: /\n" },
    );
    const n = new Normalizer({ userAgent, fetchImpl });
    const [item] = await n.normalizeAll([
      raw({ url: "https://example.com/out", text: "snippet text here" }),
    ]);
    expect(item!.text).toBe("snippet text here");
    expect(fetched(fetchImpl)).toContain("https://other.example/robots.txt");
    expect(fetched(fetchImpl)).not.toContain("https://other.example/page");
  });

  it("stops after too many redirects", async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `https://example.com/r${i}`,
        { body: "", redirectTo: `https://example.com/r${i + 1}` },
      ]),
    );
    const fetchImpl = makeFetch(pages);
    const n = new Normalizer({ userAgent, fetchImpl });
    await n.normalizeAll([raw({ url: "https://example.com/r0", text: "snippet text here" })]);
    expect(fetched(fetchImpl).filter((u) => /\/r\d+$/.test(u))).toHaveLength(6);
  });

  it("gives the same hash for the same content under different URLs", async () => {
    const n = new Normalizer({ userAgent, fetchImpl: makeFetch({}) });
    const text = "Same long text. ".repeat(60);
    const [a, b] = await n.normalizeAll([
      raw({ url: "https://a.example/1", text }),
      raw({ url: "https://b.example/2", text }),
    ]);
    expect(a!.contentHash).toBe(b!.contentHash);
  });

  it("stays within the memory budget on 200 items", async () => {
    const fetchImpl = makeFetch(
      Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`https://example.com/p${i}`, { body: html }]),
      ),
    );
    const n = new Normalizer({ userAgent, fetchImpl, batchSize: 10 });
    const before = process.memoryUsage().rss;
    const out = await n.normalizeAll(
      Array.from({ length: 200 }, (_, i) =>
        raw({ url: `https://example.com/p${i}`, title: `T${i}` }),
      ),
    );
    const growthMb = (process.memoryUsage().rss - before) / 1024 / 1024;
    expect(out).toHaveLength(200);
    expect(out.every((i) => i.text && i.language && i.canonicalUrl && i.contentHash)).toBe(true);
    expect(growthMb).toBeLessThan(150);
  }, 60_000);
});
