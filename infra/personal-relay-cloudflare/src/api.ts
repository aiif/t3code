import type { WorkerConfig, WorkerEnv } from "./config.ts";
import type { RegistryStore } from "./store/types.ts";
import type { TunnelProvisioner } from "./tunnel/types.ts";

export interface RegistryRequestContext {
  readonly env: WorkerEnv;
  readonly config: WorkerConfig;
  readonly store: RegistryStore;
  readonly provisioner: TunnelProvisioner | null;
  readonly now: () => number;
  readonly clientIp: string;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

/** Lane W replaces this route table; the context and response shapes are frozen. */
export function handleApiRequest(
  _request: Request,
  _context: RegistryRequestContext,
): Promise<Response> {
  return Promise.resolve(errorResponse(501, "Not implemented."));
}
