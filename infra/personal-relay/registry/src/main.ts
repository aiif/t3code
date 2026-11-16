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
const store = new RegistryStore(NodePath.join(config.dataDir, "registry.sqlite"), config.secretKey);
for (const host of store.migratedHosts) {
  log("Migrated host to a host key; it re-registers on its next start.", {
    hostId: host.hostId,
    environmentId: host.environmentId,
  });
}
const keys = await loadOrCreateVapidKeys(config.dataDir);

const service = new RegistryService({
  store,
  sender: createWebPushSender({
    keys,
    subject: config.vapidSubject,
    log,
  }),
  adminKey: config.adminKey,
  secretKey: config.secretKey,
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
  allowedOrigins: config.allowedOrigins,
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
    schemaVersion: 2,
  });
});
