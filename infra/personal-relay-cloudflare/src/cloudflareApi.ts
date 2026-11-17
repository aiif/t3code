const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CloudflareApiIssue {
  readonly code: number;
  readonly message: string;
}

export interface CloudflareApiResultInfo {
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly totalCount: number;
}

export interface CloudflareApiEnvelope<T> {
  readonly result: T;
  readonly errors: ReadonlyArray<CloudflareApiIssue>;
  readonly resultInfo?: CloudflareApiResultInfo | undefined;
}

export class CloudflareApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly code: number | null;

  constructor(
    message: string,
    options: {
      readonly status?: number | null;
      readonly retryable?: boolean;
      readonly code?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? null;
  }
}

export interface CloudflareApiClientOptions {
  readonly apiToken: string;
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CloudflareApiRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
}

/**
 * Thin wrapper over the Cloudflare v4 API. It owns auth, the JSON envelope,
 * timeouts and error mapping; callers only see results or CloudflareApiError.
 */
export class CloudflareApiClient {
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: CloudflareApiClientOptions) {
    this.#apiToken = options.apiToken;
    // workerd requires the global fetch to keep its globalThis receiver.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(request: CloudflareApiRequest): Promise<T> {
    const envelope = await this.requestEnvelope<T>(request);
    return envelope.result;
  }

  async requestEnvelope<T>(request: CloudflareApiRequest): Promise<CloudflareApiEnvelope<T>> {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiToken}`,
      accept: "application/json",
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CloudflareApiError("Cloudflare API request timed out.", { retryable: true }));
      }, this.#timeoutMs);
    });

    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      };
      const response = await Promise.race([this.#fetch(url, init), timeout]);
      const parsed: unknown = await response.json().catch(() => null);
      const record = isRecord(parsed) ? parsed : null;
      const errors = readIssues(record?.["errors"]);
      if (!response.ok || record?.["success"] !== true) {
        throw this.#apiError(response.status, errors);
      }
      const resultInfo = readResultInfo(record["result_info"]);
      return {
        result: record["result"] as T,
        errors,
        ...(resultInfo === undefined ? {} : { resultInfo }),
      };
    } catch (error) {
      if (error instanceof CloudflareApiError) throw error;
      if (controller.signal.aborted) {
        throw new CloudflareApiError("Cloudflare API request timed out.", { retryable: true });
      }
      const detail = error instanceof Error ? error.message.trim() : "";
      throw new CloudflareApiError(
        `Could not reach the Cloudflare API.${detail.length === 0 ? "" : ` ${this.#redact(detail)}`}`,
        { retryable: true },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #apiError(status: number, issues: ReadonlyArray<CloudflareApiIssue>): CloudflareApiError {
    const code = issues[0]?.code ?? null;
    if (code === 1055) {
      return new CloudflareApiError("Cloudflare reports the tunnel has no remote configuration.", {
        status,
        retryable: false,
        code,
      });
    }
    const retryable = status === 429 || status >= 500;
    const detail = issues
      .map((issue) => this.#redact(issue.message))
      .filter((message) => message.length > 0)
      .join(" ");
    const message =
      detail.length > 0
        ? `Cloudflare API request failed (HTTP ${status}): ${detail}`
        : `Cloudflare API request failed (HTTP ${status}).`;
    return new CloudflareApiError(message, { status, retryable, code });
  }

  #redact(message: string): string {
    if (this.#apiToken.length === 0) return message;
    return message.split(this.#apiToken).join("[redacted]");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIssues(value: unknown): ReadonlyArray<CloudflareApiIssue> {
  if (!Array.isArray(value)) return [];
  const issues: Array<CloudflareApiIssue> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const code = entry["code"];
    const message = entry["message"];
    if (typeof code === "number" && typeof message === "string") issues.push({ code, message });
  }
  return issues;
}

function readResultInfo(value: unknown): CloudflareApiResultInfo | undefined {
  if (!isRecord(value)) return undefined;
  const page = value["page"];
  const perPage = value["per_page"];
  const totalPages = value["total_pages"];
  const totalCount = value["total_count"];
  if (
    typeof page !== "number" ||
    typeof perPage !== "number" ||
    typeof totalPages !== "number" ||
    typeof totalCount !== "number"
  ) {
    return undefined;
  }
  return { page, perPage, totalPages, totalCount };
}
