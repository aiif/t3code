import type { PushSender } from "./push.ts";
import { RegistryService } from "./registry.ts";
import { RegistryStore } from "./store.ts";

export const TEST_PERSONAL_KEY = "personal-key-for-tests-0123456789abcdef";

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
}): TestRegistry {
  const store = new RegistryStore(":memory:");
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
    personalKey: TEST_PERSONAL_KEY,
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
  const spaceId = registry.service.authenticatePersonalKey(TEST_PERSONAL_KEY);
  return registry.service.registerHost(spaceId, {
    environmentId,
    label: "Home PC",
  });
}

export function subscribeTestDevice(
  registry: TestRegistry,
  endpoint = "https://push.example.test/subscription/one",
) {
  const spaceId = registry.service.authenticatePersonalKey(TEST_PERSONAL_KEY);
  registry.service.subscribe(spaceId, {
    subscription: {
      endpoint,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    },
    userAgent: "test",
  });
  return spaceId;
}
