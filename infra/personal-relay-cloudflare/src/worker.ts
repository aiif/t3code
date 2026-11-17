import {
  corsHeadersFor,
  errorResponse,
  healthBody,
  jsonResponse,
  preflightResponse,
} from "./api.ts";
import {
  resolveWorkerConfig,
  WorkerConfigError,
  type WorkerConfig,
  type WorkerEnv,
} from "./config.ts";
import { RegistryDurableObject } from "./registry.ts";

export { RegistryDurableObject };

function isApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function healthPath(pathname: string): boolean {
  return pathname.replace(/\/+$/u, "") === "/v1/health";
}

function healthResponse(request: Request, env: WorkerEnv): Response {
  let config: WorkerConfig;
  try {
    config = resolveWorkerConfig(env);
  } catch (cause) {
    const message =
      cause instanceof WorkerConfigError ? cause.message : "Relay configuration is invalid.";
    return errorResponse(503, message);
  }
  return jsonResponse(healthBody(config), 200, corsHeadersFor(request, config.allowedOrigins));
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> | Response {
    const url = new URL(request.url);
    if (!isApiPath(url.pathname)) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") {
      let allowedOrigins: ReadonlyArray<string> = [];
      try {
        allowedOrigins = resolveWorkerConfig(env).allowedOrigins;
      } catch {
        // A misconfigured relay still answers preflight for its own origin.
      }
      return preflightResponse(request, allowedOrigins);
    }
    if (request.method === "GET" && healthPath(url.pathname)) {
      return healthResponse(request, env);
    }
    return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
