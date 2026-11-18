import {
  decryptHostKey,
  hashHostKey,
  hashToken,
  hostIdFromToken,
  newHostKey,
  newHostToken,
  safeEqualText,
} from "./crypto.ts";
import type { PushSendResult, PushSender } from "./push.ts";
import type { HostRow, PushScope, PushSubscriptionRow, RegistryStore } from "./store.ts";

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
const MAX_PLATFORM_LENGTH = 40;
const MAX_THREAD_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 160;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_CLIENTS_PER_REPORT = 500;

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
  readonly adminKey: string;
  readonly secretKey: Buffer;
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
  readonly hostKey: string;
  readonly hostKeyVersion: number;
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

export interface HeartbeatResult {
  readonly hostId: string;
  readonly hostKey?: string;
  readonly hostKeyVersion?: number;
  readonly revokedSessionIds: ReadonlyArray<string>;
}

export interface AdminHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly online: boolean;
  readonly paused: boolean;
  readonly lastSeenAt: string;
  readonly publicUrl: string;
  readonly hostKey: string;
  readonly clientsCount: number;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface AdminClient {
  readonly sessionId: string;
  readonly clientLabel: string | null;
  readonly platform: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
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
 * The personal-network registry: one admin key, many hosts, per-host host keys.
 * Host keys are encrypted at rest because the admin console reveals them. Host
 * tokens are stored only as hashes.
 */
export class RegistryService {
  readonly #store: RegistryStore;
  readonly #sender: PushSender;
  readonly #adminKey: string;
  readonly #secretKey: Buffer;
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

  constructor(options: RegistryServiceOptions) {
    this.#store = options.store;
    this.#sender = options.sender;
    this.#adminKey = options.adminKey;
    this.#secretKey = options.secretKey;
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
  }

  get portalUrl(): string {
    return this.#portalUrl;
  }

  /** Verifies the relay's root credential without revealing which part was wrong. */
  authenticateAdminKey(credential: string): void {
    if (!safeEqualText(credential, this.#adminKey)) {
      throw new RegistryRequestError(401, "Invalid admin key.");
    }
  }

  authenticateHostToken(token: string): HostRow {
    const hostId = hostIdFromToken(token);
    if (hostId === null) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    const host = this.#store.findHostByTokenHash(hashToken(token));
    if (host === null || host.id !== hostId) {
      throw new RegistryRequestError(401, "Invalid host token.");
    }
    return host;
  }

  authenticateHostKey(hostKey: string): HostRow {
    const host = this.#store.findHostByKeyHash(hashHostKey(hostKey.trim()));
    if (host === null) {
      throw new RegistryRequestError(401, "Invalid host key.");
    }
    return host;
  }

  /** Admin keys subscribe to every host; a host key subscribes only to its host. */
  authenticateAnyKey(credential: string): { readonly scope: PushScope; readonly hostId: string } {
    if (safeEqualText(credential, this.#adminKey)) {
      return { scope: "admin", hostId: "" };
    }
    const host = this.#store.findHostByKeyHash(hashHostKey(credential.trim()));
    if (host !== null) {
      return { scope: "host", hostId: host.id };
    }
    throw new RegistryRequestError(401, "Invalid key.");
  }

  publicUrl(hostId: string): string {
    return `${this.#portalScheme}//${hostId}.${this.#hostDomain}`;
  }

  /** Caddy's on-demand TLS ask: only an active host's exact public hostname is allowed. */
  servesHostDomain(domain: string): boolean {
    const normalized = domain.trim().toLowerCase().replace(/\.$/u, "");
    const suffix = `.${this.#hostDomain.toLowerCase()}`;
    if (!normalized.endsWith(suffix)) return false;
    const hostId = normalized.slice(0, -suffix.length);
    if (!/^[a-z0-9]{6,32}$/u.test(hostId)) return false;
    const host = this.#store.getHost(hostId);
    return host !== null && host.revokedAt === null;
  }

  isOnline(host: HostRow): boolean {
    return (
      host.revokedAt === null &&
      host.online === 1 &&
      host.paused === 0 &&
      this.#now() - host.lastSeenAt <= this.#heartbeatTtlMs
    );
  }

  registerHost(body: unknown): RegisteredHost {
    const input = parseRecord(body);
    const environmentId = requireText(
      input["environmentId"],
      "environmentId",
      MAX_ENVIRONMENT_ID_LENGTH,
    );
    const label = optionalText(input["label"], "label", MAX_LABEL_LENGTH);
    const platform = optionalText(input["platform"], "platform", MAX_PLATFORM_LENGTH);
    const now = this.#now();
    const existing = this.#store.findHostByEnvironment(environmentId);
    if (existing !== null) {
      if (existing.revokedAt !== null) {
        throw new RegistryRequestError(410, "This host was removed.");
      }
      const hostToken = newHostToken(existing.id);
      const updated = this.#store.updateRegistration({
        hostId: existing.id,
        label,
        platform,
        hostToken,
        now,
      });
      if (updated === null) {
        throw new RegistryRequestError(410, "This host was removed.");
      }
      return this.#registered(updated, this.#decrypt(updated), hostToken);
    }
    const created = this.#store.createHost({ environmentId, label, platform, now });
    this.#log("host registered", { hostId: created.host.id, environmentId });
    return this.#registered(created.host, created.hostKey, created.hostToken);
  }

  #registered(host: HostRow, hostKey: string, hostToken: string): RegisteredHost {
    return {
      hostId: host.id,
      hostKey,
      hostKeyVersion: host.keyVersion,
      hostToken,
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

  #decrypt(host: HostRow): string {
    return decryptHostKey(this.#secretKey, host.hostKeyCiphertext);
  }

  heartbeat(host: HostRow, body: unknown): HeartbeatResult {
    const input = parseRecord(body);
    const environmentId =
      input["environmentId"] === undefined
        ? undefined
        : requireText(input["environmentId"], "environmentId", MAX_ENVIRONMENT_ID_LENGTH);
    if (environmentId !== undefined && environmentId !== host.environmentId) {
      throw new RegistryRequestError(403, "Host token does not match this environment.");
    }
    const label =
      input["label"] === undefined
        ? undefined
        : optionalText(input["label"], "label", MAX_LABEL_LENGTH);
    const online = input["online"] === undefined ? true : input["online"] === true;
    const clientVersion = typeof input["hostKeyVersion"] === "number" ? input["hostKeyVersion"] : 0;
    const updated = this.#store.touchHeartbeat({
      hostId: host.id,
      label,
      online,
      now: this.#now(),
    });
    if (updated === null) {
      throw new RegistryRequestError(410, "This host was removed.");
    }
    const now = this.#now();
    const rotation =
      clientVersion < updated.keyVersion
        ? { hostKey: this.#decrypt(updated), hostKeyVersion: updated.keyVersion }
        : {};
    return {
      hostId: updated.id,
      ...rotation,
      revokedSessionIds: this.#store.revokedClients(updated.id, now),
    };
  }

  unregister(host: HostRow): { readonly removed: boolean } {
    return { removed: this.#store.deleteHost(host.id) };
  }

  reportClients(host: HostRow, body: unknown): { readonly recorded: number } {
    const input = parseRecord(body);
    const rawClients = input["clients"];
    if (!Array.isArray(rawClients)) {
      throw new RegistryRequestError(400, "clients must be an array.");
    }
    if (rawClients.length > MAX_CLIENTS_PER_REPORT) {
      throw new RegistryRequestError(400, "clients is too long.");
    }
    const now = this.#now();
    const clients = rawClients.map((raw) => {
      const client = parseRecord(raw);
      const sessionId = requireText(
        client["sessionId"],
        "clients[].sessionId",
        MAX_SESSION_ID_LENGTH,
      );
      const firstSeenAt = parseTimestamp(client["firstSeenAt"], "clients[].firstSeenAt", now);
      const lastSeenAt = parseTimestamp(client["lastSeenAt"], "clients[].lastSeenAt", now);
      return {
        sessionId,
        clientLabel: optionalText(client["clientLabel"], "clients[].clientLabel", MAX_LABEL_LENGTH),
        platform: optionalText(client["platform"], "clients[].platform", MAX_PLATFORM_LENGTH),
        firstSeenAt,
        lastSeenAt,
        revokedAt:
          client["revokedAt"] === undefined || client["revokedAt"] === null
            ? null
            : parseTimestamp(client["revokedAt"], "clients[].revokedAt", now),
      };
    });
    this.#store.replaceClients(host.id, clients, now);
    return { recorded: clients.length };
  }

  resolveHostKey(hostKey: string): {
    readonly hostId: string;
    readonly environmentId: string;
    readonly label: string | null;
    readonly publicUrl: string;
    readonly online: boolean;
    readonly paused: boolean;
  } {
    const host = this.authenticateHostKey(hostKey);
    return {
      hostId: host.id,
      environmentId: host.environmentId,
      label: host.label,
      publicUrl: this.publicUrl(host.id),
      online: this.isOnline(host),
      paused: host.paused === 1,
    };
  }

  listAdminHosts(): { readonly hosts: ReadonlyArray<AdminHost> } {
    return {
      hosts: this.#store.listHosts().map((host) => this.#adminHost(host)),
    };
  }

  getAdminHost(hostId: string): { readonly host: AdminHost } {
    const host = this.#store.getHost(hostId);
    if (host === null || host.revokedAt !== null) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    return { host: this.#adminHost(host) };
  }

  listAdminClients(hostId: string): {
    readonly host: AdminHost;
    readonly clients: ReadonlyArray<AdminClient>;
  } {
    const { host } = this.getAdminHost(hostId);
    return {
      host,
      clients: this.#store.listClients(hostId).map((client) => ({
        sessionId: client.sessionId,
        clientLabel: client.clientLabel,
        platform: client.platform,
        firstSeenAt: new Date(client.firstSeenAt).toISOString(),
        lastSeenAt: new Date(client.lastSeenAt).toISOString(),
        revokedAt: client.revokedAt === null ? null : new Date(client.revokedAt).toISOString(),
      })),
    };
  }

  rotateHostKey(
    hostId: string,
    actor: string,
  ): { readonly hostKey: string; readonly hostKeyVersion: number } {
    const host = this.#store.getHost(hostId);
    if (host === null || host.revokedAt !== null) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    const hostKey = newHostKey();
    const hostKeyVersion = this.#store.rotateHostKey({
      hostId,
      hostKey,
      now: this.#now(),
    });
    if (hostKeyVersion === null) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    this.#store.audit({ action: "rotate-key", hostId, actor, now: this.#now() });
    return { hostKey, hostKeyVersion };
  }

  removeHost(hostId: string, actor: string): { readonly removed: boolean } {
    const removed = this.#store.revokeHost(hostId, this.#now());
    if (!removed) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    this.#store.audit({ action: "remove-host", hostId, actor, now: this.#now() });
    return { removed };
  }

  restoreHost(hostId: string, actor: string): { readonly restored: boolean } {
    const restored = this.#store.restoreHost(hostId, this.#now());
    if (!restored) {
      throw new RegistryRequestError(404, "Unknown host.");
    }
    this.#store.audit({ action: "restore-host", hostId, actor, now: this.#now() });
    return { restored };
  }

  revokeClient(hostId: string, body: unknown, actor: string): { readonly revoked: boolean } {
    const input = parseRecord(body);
    const sessionId = requireText(input["sessionId"], "sessionId", MAX_SESSION_ID_LENGTH);
    const revoked = this.#store.revokeClient(hostId, sessionId, this.#now());
    this.#store.audit({ action: "revoke-client", hostId, actor, now: this.#now() });
    return { revoked };
  }

  #adminHost(host: HostRow): AdminHost {
    return {
      hostId: host.id,
      environmentId: host.environmentId,
      label: host.label,
      platform: host.platform,
      online: this.isOnline(host),
      paused: host.paused === 1,
      lastSeenAt: new Date(host.lastSeenAt).toISOString(),
      publicUrl: this.publicUrl(host.id),
      hostKey: this.#decrypt(host),
      clientsCount: this.#store.countClients(host.id),
      createdAt: new Date(host.createdAt).toISOString(),
      revokedAt: host.revokedAt === null ? null : new Date(host.revokedAt).toISOString(),
    };
  }

  subscribe(
    input: { readonly scope: PushScope; readonly hostId: string },
    body: unknown,
  ): {
    readonly subscribed: true;
  } {
    const parsed = parseRecord(body);
    const subscription = parseRecord(parsed["subscription"]);
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
      scope: input.scope,
      hostId: input.hostId,
      endpoint,
      p256dh,
      auth,
      userAgent: optionalText(parsed["userAgent"], "userAgent", 512),
      now: this.#now(),
    });
    return { subscribed: true };
  }

  unsubscribe(
    input: { readonly scope: PushScope; readonly hostId: string },
    body: unknown,
  ): {
    readonly removed: boolean;
  } {
    const parsed = parseRecord(body);
    const endpoint = requireText(parsed["endpoint"], "endpoint", MAX_ENDPOINT_LENGTH);
    return { removed: this.#store.deletePushSubscription(input.scope, input.hostId, endpoint) };
  }

  async notify(host: HostRow, body: unknown): Promise<NotifyResult> {
    const input = parseRecord(body);
    const environmentId = requireText(
      input["environmentId"],
      "environmentId",
      MAX_ENVIRONMENT_ID_LENGTH,
    );
    if (environmentId !== host.environmentId) {
      throw new RegistryRequestError(403, "Host token does not match this environment.");
    }
    const threadId = requireText(input["threadId"], "threadId", MAX_THREAD_ID_LENGTH);
    const phase = parsePhase(input["phase"]);
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

    const subscriptions = [
      ...this.#store.listPushSubscriptions("host", host.id),
      ...this.#store.listPushSubscriptions("admin", ""),
    ];
    if (subscriptions.length === 0) {
      return { delivered: 0, removed: 0, skipped: "no-subscriptions" };
    }

    const payload = {
      title: `${PHASE_TITLES[phase]} · ${hostLabel}`,
      body: notificationBody(
        { hostId: host.id, environmentId, threadId, phase, projectTitle, threadTitle },
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
        this.#store.deletePushSubscription("host", host.id, subscription.endpoint);
        this.#store.deletePushSubscription("admin", "", subscription.endpoint);
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

function parseTimestamp(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new RegistryRequestError(400, `${what} must be an ISO timestamp or epoch milliseconds.`);
}
