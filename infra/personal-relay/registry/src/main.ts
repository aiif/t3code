import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { resolveRegistryConfig } from "./config.ts";
import { createRegistryServer } from "./http.ts";
import { createWebPushSender } from "./push.ts";
import { RegistryService } from "./registry.ts";
import { RegistryStore } from "./store.ts";
import { loadOrCreateVapidKeys } from "./vapid.ts";

function log(message: string, detail?: unknown): void {
  const line = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`;
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

const config = resolveRegistryConfig();
await NodeFSP.mkdir(config.dataDir, { recursive: true });
const store = new RegistryStore(NodePath.join(config.dataDir, "registry.sqlite"));
const keys = await loadOrCreateVapidKeys(config.dataDir);

const service = new RegistryService({
  store,
  sender: createWebPushSender({
    keys,
    subject: config.vapidSubject,
    log,
  }),
  personalKey: config.personalKey,
  portalUrl: config.portalUrl,
  hostDomain: config.hostDomain,
  frpServerAddr: config.frpServerAddr,
  frpServerPort: config.frpServerPort,
  frpAuthToken: config.frpAuthToken,
  heartbeatTtlMs: config.heartbeatTtlMs,
  notifyDedupeMs: config.notifyDedupeMs,
  log,
});

const server = createRegistryServer({
  service,
  vapidPublicKey: keys.publicKey,
  log,
});

const shutdown = (signal: string) => {
  log("Stopping registry.", { signal });
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, config.host, () => {
  log("Registry listening.", {
    host: config.host,
    port: config.port,
    portalUrl: config.portalUrl,
  });
});
