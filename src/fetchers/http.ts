export interface HttpOptions {
  userAgent: string;
  timeoutMs?: number;
  /** Total attempts, including the first one. */
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Called before every attempt, including retries. Use it for rate limits. */
  beforeAttempt?: () => Promise<void>;
}

export interface HttpResult {
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * GET a URL with a timeout, retries with exponential backoff and conditional headers.
 * Returns status 304 with an empty body when the server says "not modified".
 * Throws HttpError for a final failure.
 */
export async function httpGet(
  url: string,
  validators: { etag?: string | null; lastModified?: string | null },
  options: HttpOptions,
): Promise<HttpResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const headers: Record<string, string> = {
    "User-Agent": options.userAgent,
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
  };
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  let lastError: HttpError = new HttpError("No attempt made", null);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await options.beforeAttempt?.();
      const response = await doFetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (response.status === 304) {
        return {
          status: 304,
          body: "",
          etag: response.headers.get("etag") ?? validators.etag ?? null,
          lastModified: response.headers.get("last-modified") ?? validators.lastModified ?? null,
        };
      }
      if (response.ok) {
        return {
          status: response.status,
          body: await response.text(),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      }
      lastError = new HttpError(`HTTP ${response.status}`, response.status);
      if (!isRetryable(response.status)) throw lastError;
    } catch (error) {
      if (error instanceof HttpError && error.status !== null && !isRetryable(error.status)) {
        throw error;
      }
      if (!(error instanceof HttpError)) {
        lastError = new HttpError((error as Error).message || String(error), null);
      }
    }
    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw lastError;
}
