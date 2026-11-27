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

  it("decodes HTML entities in html text without tags", () => {
    expect(cleanText("Research &amp; development", 100)).toBe("Research & development");
    expect(cleanText("It&#8217;s here", 100)).toBe("It\u2019s here");
    expect(cleanText("a &#x2014; b", 100)).toBe("a \u2014 b");
    expect(cleanText("&copy; 2026", 100)).toBe("\u00A9 2026");
  });

  it("decodes entities and strips tags in an html item", async () => {
    const n = new Normalizer({ userAgent, fetchImpl: makeFetch({}) });
    const body = "<p>Research &amp; development &#8217;</p><p>&copy; 2026</p>".repeat(20);
    const [item] = await n.normalizeAll([raw({ text: body })]);
    expect(item!.text).toContain("Research & development \u2019");
    expect(item!.text).toContain("\u00A9 2026");
    expect(item!.text).not.toContain("<p>");
    expect(item!.text).not.toContain("&amp;");
  });

  it("keeps literal markup in the article text", () => {
    const body = `<html><body><article><h1>Dialogs</h1><p>${"Use &lt;dialog&gt; rather than &lt;div&gt; for this component, and avoid inline code. ".repeat(6)}</p><p>Example: &lt;script&gt;alert(1)&lt;/script&gt; is shown as text in this long enough paragraph about web components.</p></article></body></html>`;
    const result = extractMainText(body, "https://example.com/a", 5_000);
    expect(result.text).toContain("Use <dialog> rather than <div> for this component");
    expect(result.text).toContain("<script>alert(1)</script>");
  });

  it("keeps paragraph, list item and line break boundaries", () => {
    const filler = "This sentence adds enough text so that Readability keeps the article. ".repeat(
      8,
    );
    const body = `<html><body><article><h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p><ul><li>Item one</li><li>Item two</li></ul><p>Line A<br>Line B</p><table><tr><td>Cell1</td></tr><tr><td>Cell2</td></tr></table><p>${filler}</p></article></body></html>`;
    const text = extractMainText(body, "https://example.com/a", 5_000).text!;
    expect(text).toContain("First paragraph.\nSecond paragraph.");
    expect(text).toContain("Item one\nItem two");
    expect(text).toContain("Line A\nLine B");
    expect(text).toContain("Cell1\nCell2");
    expect(text).not.toContain("paragraph.Second");
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

  it("compares rule specificity by normalized length", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /private/x\nAllow: /%70rivate\n",
      userAgent,
    );
    expect(isPathAllowed(rules, "/private/x")).toBe(false);
    expect(isPathAllowed(rules, "/private/y")).toBe(true);
  });

  it("lets Allow win a tie of normalized lengths", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /%70rivate\n", userAgent);
    expect(isPathAllowed(rules, "/private/x")).toBe(true);
  });

  it("uses the UTF-8 length of non-ASCII rules", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /caf%C3%A9/x\nAllow: /café\n", userAgent);
    expect(isPathAllowed(rules, "/caf%C3%A9/x")).toBe(false);
    expect(isPathAllowed(rules, "/café/x")).toBe(false);
  });

  it("normalizes a raw non-ASCII path", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /caf%C3%A9\n", userAgent);
    expect(isPathAllowed(rules, "/café/news")).toBe(false);
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

  it("re-fetches a successful robots.txt after the cache TTL", async () => {
    let body = "User-agent: *\nAllow: /\n";
    const fetchImpl = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    let time = 0;
    const cache = new RobotsCache({ userAgent, fetchImpl, cacheTtlMs: 10_000, now: () => time });
    expect(await cache.isAllowed("https://example.com/private")).toBe(true);
    body = "User-agent: *\nDisallow: /private\n";
    time = 9_000;
    expect(await cache.isAllowed("https://example.com/private")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 10_001;
    expect(await cache.isAllowed("https://example.com/private")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a 24 hour cache TTL by default", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("User-agent: *\nAllow: /\n"),
    ) as unknown as typeof fetch;
    let time = 0;
    const cache = new RobotsCache({ userAgent, fetchImpl, now: () => time });
    await cache.isAllowed("https://example.com/x");
    time = 23 * 3_600_000;
    await cache.isAllowed("https://example.com/x");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 25 * 3_600_000;
    await cache.isAllowed("https://example.com/x");
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

  it("keeps literal markup in plain-text items", async () => {
    const fetchImpl = makeFetch({});
    const n = new Normalizer({ userAgent, fetchImpl });
    const text =
      "Use <dialog> rather than <div> for this component. ".repeat(15) +
      "Example: <script>alert(1)</script>";
    const [item] = await n.normalizeAll([raw({ text, textFormat: "text" })]);
    expect(item!.text).toContain("Use <dialog> rather than <div>");
    expect(item!.text).toContain("<script>alert(1)</script>");
  });

  it("still strips HTML from html items", async () => {
    const fetchImpl = makeFetch({});
    const n = new Normalizer({ userAgent, fetchImpl });
    const body = "<p>Hello <b>world</b> from the feed. </p>".repeat(30) + "<script>x()</script>";
    const [item] = await n.normalizeAll([raw({ text: body, textFormat: "html" })]);
    const [implicit] = await n.normalizeAll([raw({ text: body })]);
    for (const out of [item!, implicit!]) {
      expect(out.text).toContain("Hello world from the feed.");
      expect(out.text).not.toContain("<");
      expect(out.text).not.toContain("x()");
    }
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

describe("bounded-time matching", () => {
  it("handles a hostile wildcard rule in linear time", () => {
    const rules = { disallow: ["/" + "a*".repeat(18) + "b"], allow: [] };
    const start = performance.now();
    expect(isPathAllowed(rules, "/" + "a".repeat(36))).toBe(true);
    expect(isPathAllowed(rules, "/" + "a".repeat(36) + "b")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("keeps wildcard and $ semantics", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /a*b*c\nAllow: /a/b/c",
      userAgent,
    );
    expect(isPathAllowed(rules, "/x/file.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/x/file.pdf?x=1")).toBe(true);
    expect(isPathAllowed(rules, "/a-b-c")).toBe(false);
    expect(isPathAllowed(rules, "/a-c-b")).toBe(true);
    expect(isPathAllowed(rules, "/a/b/c")).toBe(true);
    expect(isPathAllowed({ disallow: ["/ab*b$"], allow: [] }, "/ab")).toBe(true);
    expect(isPathAllowed({ disallow: ["/ab*b$"], allow: [] }, "/abxb")).toBe(false);
  });

  it("cuts long Disallow rules and drops long Allow rules", () => {
    const long = "/" + "x".repeat(3_000);
    const rules = parseRobots(`User-agent: *\nDisallow: ${long}\nAllow: ${long}`, userAgent);
    expect(rules.disallow[0]).toHaveLength(2_000);
    expect(rules.allow).toHaveLength(0);
    expect(isPathAllowed(rules, long)).toBe(false);
  });

  it("denies all when the file has too many rules", () => {
    const body =
      "User-agent: *\n" + Array.from({ length: 1_001 }, (_, i) => `Disallow: /p${i}`).join("\n");
    expect(isPathAllowed(parseRobots(body, userAgent), "/other")).toBe(false);
  });

  it("denies a path that is too long", () => {
    expect(isPathAllowed({ disallow: [], allow: [] }, "/" + "a".repeat(5_000))).toBe(false);
  });

  it("collapses long white-space runs in linear time", () => {
    const start = performance.now();
    const out = cleanText("a" + " \r".repeat(50_000) + "b", 1_000);
    expect(out).toBe("a b");
    expect(cleanText("<a".repeat(100_000), 10)).toBeDefined();
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("treats robots.txt 429 as a transient deny", async () => {
    let now = 0;
    let status = 429;
    const fetchImpl = vi.fn(async () =>
      status === 429 ? new Response("", { status }) : new Response("User-agent: *\n"),
    );
    const cache = new RobotsCache({ userAgent, fetchImpl, failureTtlMs: 1_000, now: () => now });
    expect(await cache.isAllowed("https://e.com/a")).toBe(false);
    status = 200;
    now = 2_000;
    expect(await cache.isAllowed("https://e.com/a")).toBe(true);
  });
});
