import type { PushSender } from "./push.ts";
import { RegistryService } from "./registry.ts";
import { RegistryStore } from "./store.ts";

export const TEST_ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
export const TEST_SECRET_KEY = Buffer.alloc(32, 7);

export interface TestRegistry {
  readonly store: RegistryStore;
  readonly service: RegistryService;
  readonly sent: Array<{ readonly endpoint: string; readonly payload: unknown }>;
  readonly advance: (milliseconds: number) => void;
  readonly close: () => void;
}

export function makeTestRegistry(options?: {
  readonly sender?: PushSender;
  readonly heartbeatTtlMs?: number;
  readonly notifyDedupeMs?: number;
  readonly path?: string;
}): TestRegistry {
  const store = new RegistryStore(options?.path ?? ":memory:", TEST_SECRET_KEY);
  const sent: Array<{ readonly endpoint: string; readonly payload: unknown }> = [];
  let now = 1_700_000_000_000;
  const sender: PushSender = options?.sender ?? {
    send: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload });
      return "sent";
    },
  };
  const service = new RegistryService({
    store,
    sender,
    adminKey: TEST_ADMIN_KEY,
    secretKey: TEST_SECRET_KEY,
    portalUrl: "https://t3.example.test",
    hostDomain: "t3.example.test",
    frpServerAddr: "203.0.113.10",
    frpServerPort: 7001,
    frpAuthToken: "frp-shared-token",
    heartbeatTtlMs: options?.heartbeatTtlMs ?? 90_000,
    notifyDedupeMs: options?.notifyDedupeMs ?? 30_000,
    now: () => now,
  });
  return {
    store,
    service,
    sent,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    close: () => store.close(),
  };
}

export function registerTestHost(registry: TestRegistry, environmentId = "env-a") {
  return registry.service.registerHost({
    environmentId,
    label: "Home PC",
    platform: "win32",
  });
}

export function subscribeTestDevice(
  registry: TestRegistry,
  endpoint = "https://push.example.test/subscription/one",
  credential: string = TEST_ADMIN_KEY,
) {
  const scope = registry.service.authenticateAnyKey(credential);
  registry.service.subscribe(scope, {
    subscription: {
      endpoint,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    },
    userAgent: "test",
  });
  return scope;
}
