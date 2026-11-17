export type DeployFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareZone {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareTunnel {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareDnsRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: string;
}

export interface TokenVerification {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ZeroTrustCheck {
  readonly status: "enabled" | "disabled" | "unknown";
  readonly detail: string;
}

export class CloudflareApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly status?: number | null; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

interface CloudflareEnvelope {
  readonly success?: unknown;
  readonly result?: unknown;
  readonly errors?: ReadonlyArray<{ readonly message?: unknown }>;
  readonly result_info?: { readonly total_pages?: unknown };
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

function errorDetail(envelope: CloudflareEnvelope | null, status: number): string {
  const messages = (envelope?.errors ?? [])
    .map((error) => (typeof error.message === "string" ? error.message.trim() : ""))
    .filter((message) => message.length > 0);
  return messages.length > 0 ? messages.join("; ") : `Cloudflare answered ${status}.`;
}

/** Minimal Cloudflare API client for the deploy script. Never logs the token. */
export class CloudflareClient {
  readonly #token: string;
  readonly #fetch: DeployFetch;
  readonly #baseUrl: string;

  constructor(options: {
    readonly token: string;
    readonly fetchImpl: DeployFetch;
    readonly baseUrl?: string;
  }) {
    this.#token = options.token;
    this.#fetch = options.fetchImpl;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async #request(path: string, method = "GET"): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
        },
      });
    } catch {
      throw new CloudflareApiError("Could not reach the Cloudflare API.");
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const envelope =
      typeof body === "object" && body !== null ? (body as CloudflareEnvelope) : null;
    if (!response.ok || envelope?.success === false) {
      throw new CloudflareApiError(errorDetail(envelope, response.status), {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return envelope?.result ?? null;
  }

  async #pages(path: string): Promise<ReadonlyArray<unknown>> {
    const results: Array<unknown> = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 20; page += 1) {
      const body = (await this.#request(
        `${path}${separator}per_page=100&page=${page}`,
      )) as ReadonlyArray<unknown> | null;
      const entries = Array.isArray(body) ? body : [];
      results.push(...entries);
      if (entries.length < 100) break;
    }
    return results;
  }

  async verifyToken(): Promise<TokenVerification> {
    try {
      const result = (await this.#request("/user/tokens/verify")) as {
        readonly status?: unknown;
      } | null;
      return {
        ok: result?.status === "active",
        detail: result?.status === "active" ? "token is active" : "token status is not active",
      };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "token verification failed";
      return { ok: false, detail };
    }
  }

  async findZone(input: {
    readonly name: string;
    readonly accountId: string;
  }): Promise<CloudflareZone | null> {
    const result = (await this.#request(
      `/zones?name=${encodeURIComponent(input.name)}&account.id=${encodeURIComponent(
        input.accountId,
      )}`,
    )) as ReadonlyArray<{ readonly id?: unknown; readonly name?: unknown }> | null;
    const match = (result ?? []).find(
      (zone) =>
        typeof zone.id === "string" &&
        typeof zone.name === "string" &&
        zone.name.toLowerCase() === input.name.toLowerCase(),
    );
    return match === undefined
      ? null
      : { id: match.id as string, name: (match.name as string).toLowerCase() };
  }

  async workersSubdomain(accountId: string): Promise<string | null> {
    const result = (await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    )) as { readonly subdomain?: unknown } | null;
    return typeof result?.subdomain === "string" && result.subdomain.trim() !== ""
      ? result.subdomain.trim().toLowerCase()
      : null;
  }

  /**
   * A 403 usually means the token lacks Access Read rather than a missing
   * organization, so only a 404 counts as disabled.
   */
  async zeroTrustOrganization(accountId: string): Promise<ZeroTrustCheck> {
    try {
      await this.#request(`/accounts/${encodeURIComponent(accountId)}/access/organizations`);
      return { status: "enabled", detail: "organization is reachable" };
    } catch (cause) {
      if (cause instanceof CloudflareApiError) {
        if (cause.status === 404) {
          return { status: "disabled", detail: "no Zero Trust organization" };
        }
        return {
          status: "unknown",
          detail: `could not read the organization (${cause.message})`,
        };
      }
      throw cause;
    }
  }

  async listTunnels(accountId: string): Promise<ReadonlyArray<CloudflareTunnel>> {
    const result = await this.#pages(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false`,
    );
    return result.flatMap((entry) => {
      const tunnel = entry as { readonly id?: unknown; readonly name?: unknown };
      return typeof tunnel.id === "string" && typeof tunnel.name === "string"
        ? [{ id: tunnel.id, name: tunnel.name }]
        : [];
    });
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      "DELETE",
    );
  }

  async listDnsRecords(zoneId: string): Promise<ReadonlyArray<CloudflareDnsRecord>> {
    const result = await this.#pages(`/zones/${encodeURIComponent(zoneId)}/dns_records`);
    return result.flatMap((entry) => {
      const record = entry as {
        readonly id?: unknown;
        readonly name?: unknown;
        readonly type?: unknown;
        readonly content?: unknown;
      };
      return typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.type === "string" &&
        typeof record.content === "string"
        ? [{ id: record.id, name: record.name, type: record.type, content: record.content }]
        : [];
    });
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      "DELETE",
    );
  }
}
