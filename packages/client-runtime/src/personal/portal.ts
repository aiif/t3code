import { EnvironmentId, PersonalRegistryHosts } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PERSONAL_PORTAL_STORAGE_KEY = "t3.personal.portal";

export interface PersonalPortalConfig {
  readonly relayUrl: string;
  readonly key: string;
}

export interface PersonalPortalRecord extends PersonalPortalConfig {
  /** Environments this device already paired under this key. */
  readonly pairedEnvironmentIds: ReadonlyArray<string>;
}

export interface PersonalPortalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PersonalPortalRecordSchema = Schema.Struct({
  relayUrl: Schema.String,
  key: Schema.String,
  pairedEnvironmentIds: Schema.Array(Schema.String),
});

const decodePersonalPortalRecord = Schema.decodeSync(
  Schema.fromJsonString(PersonalPortalRecordSchema),
);
const decodePersonalRegistryHosts = Schema.decodeUnknownSync(PersonalRegistryHosts);

export class PersonalPortalError extends Schema.TaggedError<PersonalPortalError>()(
  "PersonalPortalError",
  {
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const isPersonalPortalError = Schema.is(PersonalPortalError);

function defaultStorage(): PersonalPortalStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPersonalPortalRecord(
  storage: PersonalPortalStorage | null = defaultStorage(),
): PersonalPortalRecord | null {
  if (storage === null) return null;
  const raw = storage.getItem(PERSONAL_PORTAL_STORAGE_KEY);
  if (raw === null || raw.trim() === "") return null;
  try {
    const decoded = decodePersonalPortalRecord(raw);
    if (decoded.relayUrl.trim() === "" || decoded.key.trim() === "") return null;
    return {
      relayUrl: decoded.relayUrl.replace(/\/+$/u, ""),
      key: decoded.key,
      pairedEnvironmentIds: decoded.pairedEnvironmentIds,
    };
  } catch {
    return null;
  }
}

/** Saving under a new relay or key forgets which environments the old key had paired. */
export function savePersonalPortalConfig(
  config: PersonalPortalConfig,
  storage: PersonalPortalStorage | null = defaultStorage(),
): PersonalPortalRecord {
  const relayUrl = config.relayUrl.trim().replace(/\/+$/u, "");
  const key = config.key.trim();
  if (relayUrl === "" || key === "") {
    throw new PersonalPortalError({ detail: "A relay URL and a personal key are both required." });
  }
  const previous = readPersonalPortalRecord(storage);
  const sameKey = previous !== null && previous.relayUrl === relayUrl && previous.key === key;
  const record: PersonalPortalRecord = {
    relayUrl,
    key,
    pairedEnvironmentIds: sameKey ? previous.pairedEnvironmentIds : [],
  };
  storage?.setItem(PERSONAL_PORTAL_STORAGE_KEY, JSON.stringify(record));
  return record;
}

export function recordPairedEnvironments(
  record: PersonalPortalRecord,
  environmentIds: ReadonlyArray<string>,
  storage: PersonalPortalStorage | null = defaultStorage(),
): PersonalPortalRecord {
  if (environmentIds.length === 0) return record;
  const next: PersonalPortalRecord = {
    ...record,
    pairedEnvironmentIds: [...new Set([...record.pairedEnvironmentIds, ...environmentIds])],
  };
  storage?.setItem(PERSONAL_PORTAL_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function forgetPersonalPortal(
  storage: PersonalPortalStorage | null = defaultStorage(),
): void {
  storage?.removeItem(PERSONAL_PORTAL_STORAGE_KEY);
}

export type PortalFetch = (input: string, init: RequestInit) => Promise<Response>;

/** `GET /v1/hosts` on the portal origin, authenticated with the personal key. */
export async function discoverPersonalHosts(input: {
  readonly relayUrl: string;
  readonly key: string;
  readonly fetchImpl?: PortalFetch;
}): Promise<PersonalRegistryHosts["hosts"]> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${input.relayUrl.replace(/\/+$/u, "")}/v1/hosts`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${input.key}` },
      cache: "no-store",
    });
  } catch {
    throw new PersonalPortalError({
      detail: "Could not reach the relay. Check the URL and your connection.",
    });
  }
  if (response.status === 401) {
    throw new PersonalPortalError({ detail: "The relay rejected this key.", status: 401 });
  }
  if (!response.ok) {
    throw new PersonalPortalError({
      detail: `The relay answered ${response.status}.`,
      status: response.status,
    });
  }
  const decoded = decodePersonalRegistryHosts(await response.json());
  return decoded.hosts;
}

export interface FailedHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly message: string;
}

export interface PersonalPortalSyncResult {
  readonly hosts: PersonalRegistryHosts["hosts"];
  readonly paired: ReadonlyArray<EnvironmentId>;
  readonly failures: ReadonlyArray<FailedHost>;
  /** Hosts already paired earlier; no exchange was attempted. */
  readonly skipped: ReadonlyArray<string>;
}

export type PairPersonalHost = (input: {
  readonly host: string;
  readonly pairingCode: string;
  readonly expectedEnvironmentId: EnvironmentId;
}) => Promise<unknown>;

/**
 * Discovers every host in the key space and pairs the ones this device has not
 * paired under this key. One unreachable host must not stop the others.
 */
export async function syncPersonalPortal(input: {
  readonly config: PersonalPortalConfig;
  readonly record: PersonalPortalRecord;
  readonly pair: PairPersonalHost;
  readonly fetchImpl?: PortalFetch;
}): Promise<PersonalPortalSyncResult> {
  const hosts = await discoverPersonalHosts({
    relayUrl: input.config.relayUrl,
    key: input.config.key,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const paired = new Set(input.record.pairedEnvironmentIds);
  const newlyPaired: Array<EnvironmentId> = [];
  const failures: Array<FailedHost> = [];
  const skipped: Array<string> = [];
  const claimed = new Set<string>();

  for (const host of hosts) {
    if (claimed.has(host.environmentId)) continue;
    claimed.add(host.environmentId);
    if (paired.has(host.environmentId)) {
      skipped.push(host.environmentId);
      continue;
    }
    const environmentId = EnvironmentId.make(host.environmentId);
    try {
      await input.pair({
        host: host.publicUrl,
        pairingCode: input.config.key,
        expectedEnvironmentId: environmentId,
      });
      newlyPaired.push(environmentId);
      paired.add(host.environmentId);
    } catch (cause) {
      failures.push({
        hostId: host.hostId,
        environmentId: host.environmentId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { hosts, paired: newlyPaired, failures, skipped };
}
