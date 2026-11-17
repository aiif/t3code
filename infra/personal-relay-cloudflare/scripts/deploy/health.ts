import type { DeployFetch } from "./cloudflare.ts";

export interface HealthWaitInput {
  readonly relayUrl: string;
  readonly fetchImpl: DeployFetch;
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
      const response = await input.fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && body?.ok === true) {
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
