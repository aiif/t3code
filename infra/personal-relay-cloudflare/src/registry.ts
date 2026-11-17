import { errorResponse } from "./api.ts";

/** One instance holds the registry; SQLite storage lives in this object. */
export class RegistryDurableObject implements DurableObject {
  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(errorResponse(501, "Not implemented."));
  }

  alarm(): Promise<void> {
    return Promise.resolve();
  }
}
