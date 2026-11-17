import type { WorkerEnv } from "./config.ts";
import { RegistryDurableObject } from "./registry.ts";

export { RegistryDurableObject };

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      const id = env.REGISTRY.idFromName("registry");
      return env.REGISTRY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
