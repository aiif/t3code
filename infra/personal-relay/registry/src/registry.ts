import {
  hostIdFromToken,
  hostTokenFor,
  safeEqualText,
  spaceIdFor,
  verifyHostToken,
} from "./crypto.ts";
import type { PushSendResult, PushSender } from "./push.ts";
import type { HostRow, PushSubscriptionRow, RegistryStore } from "./store.ts";

export const NOTIFICATION_PHASES = [
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
] as const;
export type NotificationPhase = (typeof NOTIFICATION_PHASES)[number];

export const HEARTBEAT_INTERVAL_MS = 30_000;

const MAX_ENVIRONMENT_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 80;
const MAX_THREAD_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 160;
const MAX_ENDPOINT_LENGTH = 2048;

export class RegistryRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RegistryRequestError";
  }
}

export interface RegistryServiceOptions {
  readonly store: RegistryStore;
  readonly sender: PushSender;
  readonly personalKey: string;
  readonly portalUrl: string;
  readonly hostDomain: string;
  readonly frpServerAddr: string;
  readonly frpServerPort: number;
  readonly frpAuthToken: string;
  readonly heartbeatTtlMs: number;
  readonly notifyDedupeMs: number;
  readonly now?: () => number;
  readonly log?: (message: string, detail?: unknown) => void;
}

export interface RegisteredHost {
  readonly hostId: string;
  readonly hostToken: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly publicUrl: string;
  readonly frp: {
    readonly serverAddr: string;
    readonly serverPort: number;
    readonly authToken: string;
    readonly domain: string;
  };
  readonly heartbeatIntervalMs: number;
}

export interface ListedHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly publicUrl: string;
  readonly online: boolean;
  readonly lastSeenAt: string;
}

export interface NotifyInput {
  readonly hostId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly phase: NotificationPhase;
  readonly projectTitle?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
  readonly hostLabel?: string | null | undefined;
}

export interface NotifyResult {
  readonly delivered: number;
  readonly removed: number;
  readonly skipped: "deduped" | "no-subscriptions" | null;
}

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent?: string | null | undefined;
}

function requireText(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new RegistryRequestError(400, `${what} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RegistryRequestError(400, `${what} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new RegistryRequestError(400, `${what} is too long.`);
  }
  return trimmed;
}

function optionalText(value: unknown, what: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RegistryRequestError(400, `${what} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new RegistryRequestError(400, `${what} is too long.`);
  }
  return trimmed;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryRequestError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function parsePhase(value: unknown): NotificationPhase {
  if (typeof value === "string" && (NOTIFICATION_PHASES as ReadonlyArray<string>).includes(value)) {
    return value as NotificationPhase;
  }
  throw new RegistryRequestError(400, `phase must be one of ${NOTIFICATION_PHASES.join(", ")}.`);
}

const PHASE_TITLES: Record<NotificationPhase, string> = {
  waiting_for_approval: "Approval needed",
  waiting_for_input: "Input needed",
  completed: "Finished",
  failed: "Failed",
};

function notificationBody(input: NotifyInput, hostLabel: string): string {
  const subject = [input.threadTitle, input.projectTitle]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" · ");
  return subject.length > 0 ? subject : `On ${hostLabel}`;
}

/**
 * The personal-mode registry: one key space, many hosts, Web Push fan-out.
 * Storage keeps only the key's SHA-256; the key itself lives in the process
 * environment and in the hosts that were told about it.
 */
export class RegistryService {
  readonly #store: RegistryStore;
  readonly #sender: PushSender;
  readonly #personalKey: string;
  readonly #portalUrl: string;
  readonly #hostDomain: string;
  readonly #portalScheme: string;
  readonly #frpServerAddr: string;
  readonly #frpServerPort: number;
  readonly #frpAuthToken: string;
  readonly #heartbeatTtlMs: number;
  readonly #notifyDedupeMs: number;
  readonly #now: () => number;
  readonly #log: (message: string, detail?: unknown) => void;
  readonly #spaceId: string;

  constructor(options: RegistryServiceOptions) {
    this.#store = options.store;
    this.#sender = options.sender;
    this.#personalKey = options.personalKey;
    this.#portalUrl = options.portalUrl;
    this.#hostDomain = options.hostDomain;
    this.#portalScheme = new URL(options.portalUrl).protocol;
    this.#frpServerAddr = options.frpServerAddr;
    this.#frpServerPort = options.frpServerPort;
    this.#frpAuthToken = options.frpAuthToken;
    this.#heartbeatTtlMs = options.heartbeatTtlMs;
    this.#notifyDedupeMs = options.notifyDedupeMs;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#spaceId = spaceIdFor(options.personalKey);
  }

  get portalUrl(): string {
    return this.#portalUrl;
  }

  /** Verifies the personal key without revealing which part was wrong. */
  authenticatePersonalKey(credential: string): string {
    if (!safeEqualText(spaceIdFor(credential), this.#spaceId)) {
      throw new RegistryRequestError(401, "Invalid personal key.");
    }
    return this.#spaceId;
  }

  authenticateHostToken(token: string): HostRow {
    const hostId = hostIdFromToken(token);
    if (hostId === null) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    const host = this.#store.getHost(hostId);
    if (host === null || host.spaceId !== this.#spaceId) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    if (!verifyHostToken(this.#personalKey, hostId, token)) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    return host;
  }

  publicUrl(hostId: string): string {
    return `${this.#portalScheme}//${hostId}.${this.#hostDomain}`;
  }

  registerHost(spaceId: string, body: unknown): RegisteredHost {
    const input = parseRecord(body);
    const environmentId = requireText(
      input["environmentId"],
      "environmentId",
      MAX_ENVIRONMENT_ID_LENGTH,
    );
    const label = optionalText(input["label"], "label", MAX_LABEL_LENGTH);
    const now = this.#now();
    const host = this.#store.registerHost({ spaceId, environmentId, label, now });
    return {
      hostId: host.id,
      hostToken: hostTokenFor(this.#personalKey, host.id),
      environmentId: host.environmentId,
      label: host.label,
      publicUrl: this.publicUrl(host.id),
      frp: {
        serverAddr: this.#frpServerAddr,
        serverPort: this.#frpServerPort,
        authToken: this.#frpAuthToken,
        domain: `${host.id}.${this.#hostDomain}`,
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    };
  }

  heartbeat(host: HostRow, body: unknown): { readonly hostId: string } {
    const input = parseRecord(body);
    const environmentId =
      input["environmentId"] === undefined
        ? undefined
        : requireText(input["environmentId"], "environmentId", MAX_ENVIRONMENT_ID_LENGTH);
    const label =
      input["label"] === undefined
        ? undefined
        : optionalText(input["label"], "label", MAX_LABEL_LENGTH);
    const updated = this.#store.touchHost({
      hostId: host.id,
      environmentId,
      label,
      now: this.#now(),
    });
    if (updated === null) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    return { hostId: updated.id };
  }

  unregister(host: HostRow): { readonly removed: boolean } {
    return { removed: this.#store.deleteHost(host.id) };
  }

  listHosts(spaceId: string): { readonly hosts: ReadonlyArray<ListedHost> } {
    const now = this.#now();
    return {
      hosts: this.#store.listHosts(spaceId).map((host) => ({
        hostId: host.id,
        environmentId: host.environmentId,
        label: host.label,
        publicUrl: this.publicUrl(host.id),
        online: now - host.updatedAt <= this.#heartbeatTtlMs,
        lastSeenAt: new Date(host.updatedAt).toISOString(),
      })),
    };
  }

  subscribe(spaceId: string, body: unknown): { readonly subscribed: true } {
    const input = parseRecord(body);
    const subscription = parseRecord(input["subscription"]);
    const endpoint = requireText(
      subscription["endpoint"],
      "subscription.endpoint",
      MAX_ENDPOINT_LENGTH,
    );
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new RegistryRequestError(400, "subscription.endpoint must be a URL.");
    }
    if (parsedEndpoint.protocol !== "https:") {
      throw new RegistryRequestError(400, "subscription.endpoint must use https.");
    }
    const keys = parseRecord(subscription["keys"]);
    const p256dh = requireText(keys["p256dh"], "subscription.keys.p256dh", 512);
    const auth = requireText(keys["auth"], "subscription.keys.auth", 256);
    this.#store.upsertPushSubscription({
      spaceId,
      // Keep the push service's exact endpoint: unsubscribe sends it back verbatim.
      endpoint,
      p256dh,
      auth,
      userAgent: optionalText(input["userAgent"], "userAgent", 512),
      now: this.#now(),
    });
    return { subscribed: true };
  }

  unsubscribe(spaceId: string, body: unknown): { readonly removed: boolean } {
    const input = parseRecord(body);
    const endpoint = requireText(input["endpoint"], "endpoint", MAX_ENDPOINT_LENGTH);
    return { removed: this.#store.deletePushSubscription(spaceId, endpoint) };
  }

  async notify(spaceId: string, body: unknown): Promise<NotifyResult> {
    const input = parseRecord(body);
    const hostId = requireText(input["hostId"], "hostId", 64);
    const environmentId = requireText(
      input["environmentId"],
      "environmentId",
      MAX_ENVIRONMENT_ID_LENGTH,
    );
    const threadId = requireText(input["threadId"], "threadId", MAX_THREAD_ID_LENGTH);
    const phase = parsePhase(input["phase"]);
    const host = this.#store.getHost(hostId);
    if (host === null || host.spaceId !== spaceId || host.environmentId !== environmentId) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    const projectTitle = optionalText(input["projectTitle"], "projectTitle", MAX_TEXT_LENGTH);
    const threadTitle = optionalText(input["threadTitle"], "threadTitle", MAX_TEXT_LENGTH);
    const hostLabel =
      optionalText(input["hostLabel"], "hostLabel", MAX_LABEL_LENGTH) ??
      host.label ??
      host.environmentId;

    const now = this.#now();
    this.#store.pruneNotifications(now - Math.max(this.#notifyDedupeMs, 60 * 60 * 1000));
    const dedupeKey = `${host.id}:${threadId}:${phase}`;
    if (this.#store.wasNotifiedRecently(dedupeKey, now, this.#notifyDedupeMs)) {
      return { delivered: 0, removed: 0, skipped: "deduped" };
    }

    const subscriptions = this.#store.listPushSubscriptions(spaceId);
    if (subscriptions.length === 0) {
      return { delivered: 0, removed: 0, skipped: "no-subscriptions" };
    }

    const payload = {
      title: `${PHASE_TITLES[phase]} · ${hostLabel}`,
      body: notificationBody(
        { hostId, environmentId, threadId, phase, projectTitle, threadTitle },
        hostLabel,
      ),
      hostId: host.id,
      environmentId,
      threadId,
      phase,
      tag: threadId,
    };

    let delivered = 0;
    let removed = 0;
    for (const subscription of subscriptions) {
      const result = await this.#send(subscription, payload);
      if (result === "sent") delivered += 1;
      if (result === "gone") {
        this.#store.deletePushSubscription(spaceId, subscription.endpoint);
        removed += 1;
      }
    }
    this.#store.recordNotification(dedupeKey, now);
    return { delivered, removed, skipped: null };
  }

  async #send(subscription: PushSubscriptionRow, payload: unknown): Promise<PushSendResult> {
    try {
      return await this.#sender.send(subscription, payload);
    } catch (cause) {
      this.#log("Push sender threw.", { cause });
      return "failed";
    }
  }
}
