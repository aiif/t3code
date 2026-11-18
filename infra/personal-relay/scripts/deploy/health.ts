export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HealthWaitInput {
  readonly relayUrl: string;
  readonly fetchImpl: FetchLike;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly attempts: number;
  readonly intervalMs: number;
}

export interface HealthWaitResult {
  readonly ok: boolean;
  readonly detail: string;
}

export async function waitForRelayHealth(input: HealthWaitInput): Promise<HealthWaitResult> {
  const url = `${input.relayUrl.replace(/\/+$/u, "")}/v1/health`;
  let detail = "no response";
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      const response = await input.fetchImpl(url, { headers: { accept: "application/json" } });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && body?.["ok"] === true) {
        return { ok: true, detail: `${url} is healthy` };
      }
      detail = response.ok
        ? `${url} answered without ok: true`
        : `${url} answered ${response.status}`;
    } catch {
      detail = `could not reach ${url}`;
    }
    if (attempt < input.attempts) await input.sleep(input.intervalMs);
  }
  return { ok: false, detail };
}

export async function checkPortal(input: {
  readonly relayUrl: string;
  readonly fetchImpl: FetchLike;
}): Promise<HealthWaitResult> {
  const url = `${input.relayUrl.replace(/\/+$/u, "")}/`;
  try {
    const response = await input.fetchImpl(url, { headers: { accept: "text/html" } });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("text/html")) {
      return { ok: true, detail: `${url} serves the admin console.` };
    }
    return {
      ok: false,
      detail: `${url} answered ${response.status} (${contentType || "no content type"})`,
    };
  } catch (cause) {
    return { ok: false, detail: `could not reach ${url}: ${(cause as Error).message}` };
  }
}
