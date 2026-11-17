// @effect-diagnostics globalDate:off -- Client timestamps come from the platform clock outside an Effect runtime.
import {
  PersonalAdminHostDetail,
  PersonalAdminHosts,
  PersonalHostKeyResult,
  PersonalResolvedHost,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Admin credentials live under their own keys; they are never guest credentials. */
export const PERSONAL_ADMIN_KEY_STORAGE = "t3.admin.key";
const PERSONAL_ADMIN_RELAY_STORAGE = "t3.admin.relay";

/** Guest host records: one entry per host key this device holds. */
export const PERSONAL_HOSTS_STORAGE_KEY = "t3.personal.hosts";

export interface PersonalAdminConfig {
  readonly relayUrl: string;
  readonly adminKey: string;
}

export interface PersonalHostRecord {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly hostId: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly publicUrl: string;
  readonly online: boolean;
  readonly paused: boolean;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface PersonalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PersonalHostRecordSchema = Schema.Struct({
  relayUrl: Schema.String,
  hostKey: Schema.String,
  hostId: Schema.String,
  environmentId: Schema.String,
  label: Schema.NullOr(Schema.String),
  publicUrl: Schema.String,
  online: Schema.Boolean,
  paused: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const PersonalHostsSchema = Schema.Array(PersonalHostRecordSchema);
const decodeHosts = Schema.decodeUnknownSync(Schema.fromJsonString(PersonalHostsSchema));
const decodeResolved = Schema.decodeUnknownSync(PersonalResolvedHost);
const decodeAdminHosts = Schema.decodeUnknownSync(PersonalAdminHosts);
const decodeAdminDetail = Schema.decodeUnknownSync(PersonalAdminHostDetail);
const decodeHostKey = Schema.decodeUnknownSync(PersonalHostKeyResult);

export class PersonalAdminError extends Schema.TaggedError<PersonalAdminError>()(
  "PersonalAdminError",
  {
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PersonalHostError extends Schema.TaggedError<PersonalHostError>()(
  "PersonalHostError",
  {
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const isPersonalAdminError = Schema.is(PersonalAdminError);

export type PersonalFetch = (input: string, init: RequestInit) => Promise<Response>;

function defaultStorage(): PersonalStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultFetch(): PersonalFetch {
  return globalThis.fetch.bind(globalThis);
}

function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function readPersonalAdminConfig(
  storage: PersonalStorage | null = defaultStorage(),
): PersonalAdminConfig | null {
  if (storage === null) return null;
  const adminKey = storage.getItem(PERSONAL_ADMIN_KEY_STORAGE)?.trim() ?? "";
  if (adminKey === "") return null;
  const relayUrl = normalizeRelayUrl(
    storage.getItem(PERSONAL_ADMIN_RELAY_STORAGE) ?? globalThis.location?.origin ?? "",
  );
  return { relayUrl, adminKey };
}

export function savePersonalAdminConfig(
  config: PersonalAdminConfig,
  storage: PersonalStorage | null = defaultStorage(),
): PersonalAdminConfig {
  const relayUrl = normalizeRelayUrl(config.relayUrl);
  const adminKey = config.adminKey.trim();
  if (relayUrl === "" || adminKey === "") {
    throw new PersonalAdminError({ detail: "A relay URL and the admin key are both required." });
  }
  storage?.setItem(PERSONAL_ADMIN_KEY_STORAGE, adminKey);
  storage?.setItem(PERSONAL_ADMIN_RELAY_STORAGE, relayUrl);
  return { relayUrl, adminKey };
}

export function forgetPersonalAdminConfig(
  storage: PersonalStorage | null = defaultStorage(),
): void {
  storage?.removeItem(PERSONAL_ADMIN_KEY_STORAGE);
}

async function adminRequest(
  config: PersonalAdminConfig,
  path: string,
  init: RequestInit = {},
  fetchImpl: PersonalFetch = defaultFetch(),
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${normalizeRelayUrl(config.relayUrl)}/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.adminKey}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      cache: "no-store",
    });
  } catch {
    throw new PersonalAdminError({
      detail: "Could not reach the relay. Check the URL and your connection.",
    });
  }
  if (response.status === 401) {
    throw new PersonalAdminError({ detail: "The relay rejected this admin key.", status: 401 });
  }
  if (!response.ok) {
    throw new PersonalAdminError({
      detail: `The relay answered ${response.status}.`,
      status: response.status,
    });
  }
  if (response.status === 204) return {};
  return response.json();
}

export async function listAdminHosts(input: {
  readonly config: PersonalAdminConfig;
  readonly fetchImpl?: PersonalFetch;
}): Promise<PersonalAdminHosts["hosts"]> {
  const decoded = decodeAdminHosts(
    await adminRequest(input.config, "/admin/hosts", {}, input.fetchImpl),
  );
  return decoded.hosts;
}

export async function getAdminHost(input: {
  readonly config: PersonalAdminConfig;
  readonly hostId: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<PersonalAdminHostDetail> {
  return decodeAdminDetail(
    await adminRequest(
      input.config,
      `/admin/hosts/${encodeURIComponent(input.hostId)}/clients`,
      {},
      input.fetchImpl,
    ),
  );
}

export async function rotateAdminHostKey(input: {
  readonly config: PersonalAdminConfig;
  readonly hostId: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<string> {
  const decoded = decodeHostKey(
    await adminRequest(
      input.config,
      `/admin/hosts/${encodeURIComponent(input.hostId)}/rotate-key`,
      { method: "POST" },
      input.fetchImpl,
    ),
  );
  return decoded.hostKey;
}

export async function removeAdminHost(input: {
  readonly config: PersonalAdminConfig;
  readonly hostId: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<void> {
  await adminRequest(
    input.config,
    `/admin/hosts/${encodeURIComponent(input.hostId)}/remove`,
    { method: "POST" },
    input.fetchImpl,
  );
}

export async function restoreAdminHost(input: {
  readonly config: PersonalAdminConfig;
  readonly hostId: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<void> {
  await adminRequest(
    input.config,
    `/admin/hosts/${encodeURIComponent(input.hostId)}/restore`,
    { method: "POST" },
    input.fetchImpl,
  );
}

export async function revokeAdminClient(input: {
  readonly config: PersonalAdminConfig;
  readonly hostId: string;
  readonly sessionId: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<boolean> {
  const result = (await adminRequest(
    input.config,
    `/admin/hosts/${encodeURIComponent(input.hostId)}/revoke-client`,
    { method: "POST", body: JSON.stringify({ sessionId: input.sessionId }) },
    input.fetchImpl,
  )) as { readonly revoked?: unknown };
  return result.revoked === true;
}

export function readPersonalHosts(
  storage: PersonalStorage | null = defaultStorage(),
): ReadonlyArray<PersonalHostRecord> {
  if (storage === null) return [];
  const raw = storage.getItem(PERSONAL_HOSTS_STORAGE_KEY);
  if (raw === null || raw.trim() === "") return [];
  try {
    return decodeHosts(raw).filter(
      (host) => host.relayUrl.trim() !== "" && host.hostKey.trim() !== "",
    );
  } catch {
    return [];
  }
}

function writePersonalHosts(
  hosts: ReadonlyArray<PersonalHostRecord>,
  storage: PersonalStorage | null,
): void {
  storage?.setItem(PERSONAL_HOSTS_STORAGE_KEY, JSON.stringify(hosts));
}

export function upsertPersonalHost(
  record: PersonalHostRecord,
  storage: PersonalStorage | null = defaultStorage(),
): ReadonlyArray<PersonalHostRecord> {
  const hosts = readPersonalHosts(storage);
  const next = [
    ...hosts.filter((host) => host.hostId !== record.hostId || host.relayUrl !== record.relayUrl),
    record,
  ];
  writePersonalHosts(next, storage);
  return next;
}

export function removePersonalHost(
  input: { readonly hostId: string; readonly relayUrl: string },
  storage: PersonalStorage | null = defaultStorage(),
): ReadonlyArray<PersonalHostRecord> {
  const next = readPersonalHosts(storage).filter(
    (host) => host.hostId !== input.hostId || host.relayUrl !== normalizeRelayUrl(input.relayUrl),
  );
  writePersonalHosts(next, storage);
  return next;
}

/** Resolves a host key to the host URL; the guest then pairs with that URL. */
export async function resolvePersonalHost(input: {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly fetchImpl?: PersonalFetch;
}): Promise<PersonalResolvedHost> {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  const hostKey = input.hostKey.trim();
  if (relayUrl === "" || hostKey === "") {
    throw new PersonalHostError({ detail: "A relay URL and a host key are both required." });
  }
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${relayUrl}/v1/hosts/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${hostKey}` },
      cache: "no-store",
    });
  } catch {
    throw new PersonalHostError({
      detail: "Could not reach the relay. Check the URL and your connection.",
    });
  }
  if (response.status === 401) {
    throw new PersonalHostError({
      detail: "This host key is invalid or was rotated.",
      status: 401,
    });
  }
  if (!response.ok) {
    throw new PersonalHostError({
      detail: `The relay answered ${response.status}.`,
      status: response.status,
    });
  }
  return decodeResolved(await response.json());
}

export function personalHostRecord(input: {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly resolved: PersonalResolvedHost;
}): PersonalHostRecord {
  return {
    relayUrl: normalizeRelayUrl(input.relayUrl),
    hostKey: input.hostKey.trim(),
    hostId: input.resolved.hostId,
    environmentId: input.resolved.environmentId,
    label: input.resolved.label,
    publicUrl: input.resolved.publicUrl,
    online: input.resolved.online,
    paused: input.resolved.paused,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Refreshes online/paused state for saved hosts; a failed host keeps its last good state. */
export async function refreshPersonalHosts(
  input: {
    readonly hosts?: ReadonlyArray<PersonalHostRecord>;
    readonly fetchImpl?: PersonalFetch;
    readonly storage?: PersonalStorage | null;
  } = {},
): Promise<ReadonlyArray<PersonalHostRecord>> {
  const hosts = input.hosts ?? readPersonalHosts();
  const refreshed: Array<PersonalHostRecord> = [];
  for (const host of hosts) {
    try {
      const resolved = await resolvePersonalHost({
        relayUrl: host.relayUrl,
        hostKey: host.hostKey,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      });
      refreshed.push({
        ...host,
        hostId: resolved.hostId,
        environmentId: resolved.environmentId,
        label: resolved.label,
        publicUrl: resolved.publicUrl,
        online: resolved.online,
        paused: resolved.paused,
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (cause) {
      refreshed.push({
        ...host,
        online: false,
        lastError: cause instanceof Error ? cause.message : String(cause),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  writePersonalHosts(refreshed, input.storage === undefined ? defaultStorage() : input.storage);
  return refreshed;
}
