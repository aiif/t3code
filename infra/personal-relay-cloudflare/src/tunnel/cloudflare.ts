import { CloudflareApiClient, CloudflareApiError } from "../cloudflareApi.ts";
import { describeError, logRelayEvent } from "../logging.ts";
import { TunnelProvisionError } from "./types.ts";
import type {
  TunnelEnsureInput,
  TunnelEnsureResult,
  TunnelProvisioner,
  TunnelRemoveInput,
  TunnelSweepInput,
} from "./types.ts";

export { CloudflareApiError } from "../cloudflareApi.ts";

export interface CloudflareTunnelProvisionerOptions {
  readonly accountId: string;
  readonly zoneId: string;
  readonly hostsSuffix: string;
  readonly tunnelPrefix: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

const ORIGIN_HOST = "127.0.0.1";
const TUNNEL_TARGET_SUFFIX = ".cfargotunnel.com";
const PAGE_SIZE = "100";

interface CloudflareTunnel {
  readonly id: string;
  readonly name: string;
}

interface CloudflareDnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly proxied?: boolean | undefined;
  readonly ttl?: number | undefined;
}

export function createCloudflareTunnelProvisioner(
  options: CloudflareTunnelProvisionerOptions,
): TunnelProvisioner {
  return new CloudflareTunnelProvisioner(options);
}

class CloudflareTunnelProvisioner implements TunnelProvisioner {
  readonly #api: CloudflareApiClient;
  readonly #accountId: string;
  readonly #zoneId: string;
  readonly #hostsSuffix: string;
  readonly #tunnelPrefix: string;

  constructor(options: CloudflareTunnelProvisionerOptions) {
    this.#api = new CloudflareApiClient({
      apiToken: options.apiToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#accountId = options.accountId;
    this.#zoneId = options.zoneId;
    this.#hostsSuffix = normalizeSuffix(options.hostsSuffix);
    this.#tunnelPrefix = normalizePrefix(options.tunnelPrefix);
  }

  async ensure(input: TunnelEnsureInput): Promise<TunnelEnsureResult> {
    const hostId = assertHostId(input.hostId);
    const hostname = this.#hostname(hostId);
    assertOriginPort(input.originPort);
    logRelayEvent("tunnel_ensure_started", { hostId, hostname, originPort: input.originPort });
    try {
      const tunnel = await this.#ensureTunnel(hostId);
      await this.#configureIngress(tunnel.id, hostname, input.originPort);
      logRelayEvent("tunnel_ingress_configured", {
        hostId,
        tunnelId: tunnel.id,
        hostname,
        originPort: input.originPort,
      });
      const tunnelToken = await this.#fetchTunnelToken(tunnel.id);
      logRelayEvent("tunnel_token_fetched", { hostId, tunnelId: tunnel.id });
      const dnsRecordId = await this.#ensureDnsRecord(tunnel.id, hostname);
      logRelayEvent("tunnel_ensure_succeeded", {
        hostId,
        hostname,
        tunnelId: tunnel.id,
        dnsRecordId,
      });
      return { tunnelId: tunnel.id, tunnelToken, hostname, dnsRecordId };
    } catch (error) {
      logRelayEvent("tunnel_ensure_failed", { hostId, hostname, error: describeError(error) });
      throw toProvisionError(error);
    }
  }

  async remove(input: TunnelRemoveInput): Promise<void> {
    const hostId = assertHostId(input.hostId);
    const errors: Array<unknown> = [];
    let tunnelId = input.tunnelId ?? null;
    logRelayEvent("tunnel_remove_started", {
      hostId,
      tunnelId,
      hostname: input.hostname ?? null,
    });
    if (tunnelId === null) {
      await attempt(errors, async () => {
        const tunnel = await this.#findTunnel(this.#tunnelName(hostId));
        tunnelId = tunnel?.id ?? null;
      });
    }
    if (tunnelId !== null) {
      const id = tunnelId;
      await attempt(errors, () => this.#deleteConnections(id), isNotFound);
      await attempt(errors, () => this.#deleteTunnel(id), isNotFound);
    }
    await attempt(
      errors,
      () =>
        this.#deleteDnsRecord({
          tunnelId,
          dnsRecordId: input.dnsRecordId,
          hostname: input.hostname,
          hostId,
        }),
      isNotFound,
    );
    const first = errors[0];
    if (first !== undefined) {
      logRelayEvent("tunnel_remove_failed", { hostId, tunnelId, error: describeError(first) });
      throw toProvisionError(first);
    }
    logRelayEvent("tunnel_removed", { hostId, tunnelId });
  }

  async sweep(input: TunnelSweepInput): Promise<void> {
    const tunnels = await this.#listTunnels();
    const owned: Array<{ readonly tunnel: CloudflareTunnel; readonly hostId: string }> = [];
    for (const tunnel of tunnels) {
      const hostId = this.#hostIdFromTunnelName(tunnel.name);
      if (hostId !== null) owned.push({ tunnel, hostId });
    }
    if (owned.length === 0) return;

    const records = await this.#listDnsRecords();
    const errors: Array<unknown> = [];
    for (const { tunnel, hostId } of owned) {
      const target = tunnelTarget(tunnel.id);
      const linked = records.filter(
        (record) => isCname(record) && record.content.toLowerCase() === target,
      );
      // activeHostIds lists hosts that should still have a named tunnel; quick and
      // revoked-past-grace hosts are excluded so their tunnels and DNS are removed.
      if (input.activeHostIds.has(hostId)) {
        await attempt(errors, () => this.#reconcileDns(hostId, tunnel.id, linked, records));
      } else {
        await attempt(errors, () => this.#deleteTunnelAndDns(tunnel.id, linked));
      }
    }
    const first = errors[0];
    if (first !== undefined) throw toProvisionError(first);
  }

  async #ensureTunnel(hostId: string): Promise<CloudflareTunnel> {
    const name = this.#tunnelName(hostId);
    const existing = await this.#findTunnel(name);
    if (existing !== null) {
      logRelayEvent("tunnel_reused", { hostId, tunnelId: existing.id, name });
      return existing;
    }
    try {
      const created = await this.#api.request<CloudflareTunnel>({
        method: "POST",
        path: `/accounts/${this.#accountId}/cfd_tunnel`,
        body: { name, config_src: "cloudflare" },
      });
      logRelayEvent("tunnel_created", { hostId, tunnelId: created.id, name });
      return created;
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 409) throw error;
      const raced = await this.#findTunnel(name);
      if (raced === null) throw error;
      logRelayEvent("tunnel_reused_after_race", { hostId, tunnelId: raced.id, name });
      return raced;
    }
  }

  #configureIngress(tunnelId: string, hostname: string, originPort: number): Promise<unknown> {
    return this.#api.request({
      method: "PUT",
      path: `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/configurations`,
      body: {
        config: {
          ingress: [
            { hostname, service: `http://${ORIGIN_HOST}:${originPort}` },
            { service: "http_status:404" },
          ],
        },
      },
    });
  }

  async #fetchTunnelToken(tunnelId: string): Promise<string> {
    const token = await this.#api.request<unknown>({
      method: "GET",
      path: `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/token`,
    });
    if (typeof token !== "string" || token.length === 0) {
      throw new CloudflareApiError("Cloudflare did not return a tunnel token.");
    }
    return token;
  }

  async #ensureDnsRecord(tunnelId: string, hostname: string, attempt = 0): Promise<string> {
    const records = await this.#listDnsRecords(hostname);
    const target = tunnelTarget(tunnelId);
    const ours = records.find((record) => isCname(record) && isTunnelTarget(record.content));
    const conflict = records.find((record) => !isCname(record) || !isTunnelTarget(record.content));
    if (conflict !== undefined) {
      throw new TunnelProvisionError(
        `Cloudflare DNS name ${hostname} is already used by another record.`,
        { status: 409 },
      );
    }
    if (ours !== undefined) {
      if (ours.content.toLowerCase() === target && ours.proxied === true && ours.ttl === 1) {
        return ours.id;
      }
      return this.#updateDnsRecord(ours.id, hostname, target);
    }
    try {
      return await this.#createDnsRecord(hostname, target);
    } catch (error) {
      if (attempt === 0 && error instanceof CloudflareApiError && error.status === 409) {
        return this.#ensureDnsRecord(tunnelId, hostname, 1);
      }
      throw error;
    }
  }

  async #createDnsRecord(hostname: string, target: string): Promise<string> {
    const record = await this.#api.request<CloudflareDnsRecord>({
      method: "POST",
      path: `/zones/${this.#zoneId}/dns_records`,
      body: { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 },
    });
    return record.id;
  }

  async #updateDnsRecord(recordId: string, hostname: string, target: string): Promise<string> {
    const record = await this.#api.request<CloudflareDnsRecord>({
      method: "PATCH",
      path: `/zones/${this.#zoneId}/dns_records/${recordId}`,
      body: { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 },
    });
    return record.id;
  }

  async #deleteDnsRecord(input: {
    readonly tunnelId: string | null;
    readonly dnsRecordId?: string | undefined;
    readonly hostname?: string | undefined;
    readonly hostId: string;
  }): Promise<void> {
    if (input.tunnelId === null) return;
    const target = tunnelTarget(input.tunnelId);
    const hostname = input.hostname ?? this.#hostname(input.hostId);
    let record: CloudflareDnsRecord | null = null;
    if (input.dnsRecordId === undefined) {
      const named = await this.#listDnsRecords(hostname);
      record =
        named.find((entry) => isCname(entry) && entry.content.toLowerCase() === target) ?? null;
      if (record === null) {
        const all = await this.#listDnsRecords();
        record =
          all.find((entry) => isCname(entry) && entry.content.toLowerCase() === target) ?? null;
      }
    } else {
      record = await this.#findDnsRecordById(input.dnsRecordId, hostname);
    }
    if (record === null) return;
    if (!isCname(record) || record.content.toLowerCase() !== target) return;
    await this.#deleteDnsRecordById(record.id);
  }

  async #findDnsRecordById(
    dnsRecordId: string,
    hostname: string,
  ): Promise<CloudflareDnsRecord | null> {
    const named = await this.#listDnsRecords(hostname);
    const found = named.find((record) => record.id === dnsRecordId);
    if (found !== undefined) return found;
    const all = await this.#listDnsRecords();
    return all.find((record) => record.id === dnsRecordId) ?? null;
  }

  async #reconcileDns(
    hostId: string,
    tunnelId: string,
    linked: ReadonlyArray<CloudflareDnsRecord>,
    records: ReadonlyArray<CloudflareDnsRecord>,
  ): Promise<void> {
    const hostname = this.#hostname(hostId);
    const target = tunnelTarget(tunnelId);
    const canonical = linked.find((record) => record.name === hostname);
    const occupied = records.some((record) => record.name === hostname);
    if (canonical === undefined && occupied) return;

    const source = canonical ?? linked[0];
    if (source === undefined) {
      try {
        await this.#createDnsRecord(hostname, target);
      } catch (error) {
        if (!(error instanceof CloudflareApiError) || error.status !== 409) throw error;
      }
      return;
    }
    if (
      source.name !== hostname ||
      source.content.toLowerCase() !== target ||
      source.proxied !== true ||
      source.ttl !== 1
    ) {
      await this.#updateDnsRecord(source.id, hostname, target);
    }
    for (const record of linked) {
      if (record.id !== source.id) await this.#deleteDnsRecordById(record.id);
    }
  }

  async #deleteTunnelAndDns(
    tunnelId: string,
    linked: ReadonlyArray<CloudflareDnsRecord>,
  ): Promise<void> {
    const errors: Array<unknown> = [];
    await attempt(errors, () => this.#deleteConnections(tunnelId), isNotFound);
    await attempt(errors, () => this.#deleteTunnel(tunnelId), isNotFound);
    for (const record of linked) {
      await attempt(errors, () => this.#deleteDnsRecordById(record.id), isNotFound);
    }
    const first = errors[0];
    if (first !== undefined) throw first;
  }

  #deleteConnections(tunnelId: string): Promise<unknown> {
    return this.#api.request({
      method: "DELETE",
      path: `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/connections`,
    });
  }

  #deleteTunnel(tunnelId: string): Promise<unknown> {
    return this.#api.request({
      method: "DELETE",
      path: `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`,
    });
  }

  #deleteDnsRecordById(recordId: string): Promise<unknown> {
    return this.#api.request({
      method: "DELETE",
      path: `/zones/${this.#zoneId}/dns_records/${recordId}`,
    });
  }

  #listTunnels(): Promise<Array<CloudflareTunnel>> {
    return this.#listAll<CloudflareTunnel>(`/accounts/${this.#accountId}/cfd_tunnel`);
  }

  #listDnsRecords(name?: string): Promise<Array<CloudflareDnsRecord>> {
    return this.#listAll<CloudflareDnsRecord>(
      `/zones/${this.#zoneId}/dns_records`,
      name === undefined ? undefined : { name },
    );
  }

  async #findTunnel(name: string): Promise<CloudflareTunnel | null> {
    const tunnels = await this.#listAll<CloudflareTunnel>(
      `/accounts/${this.#accountId}/cfd_tunnel`,
      { name },
    );
    return tunnels.find((tunnel) => tunnel.name === name) ?? null;
  }

  async #listAll<T>(
    path: string,
    query?: Readonly<Record<string, string>> | undefined,
  ): Promise<Array<T>> {
    const items: Array<T> = [];
    let page = 1;
    for (;;) {
      const envelope = await this.#api.requestEnvelope<Array<T>>({
        method: "GET",
        path,
        query: { ...query, page: String(page), per_page: PAGE_SIZE },
      });
      if (!Array.isArray(envelope.result)) {
        throw new CloudflareApiError("Cloudflare API returned an unexpected list response.");
      }
      items.push(...envelope.result);
      const totalPages = envelope.resultInfo?.totalPages;
      if (totalPages === undefined || page >= totalPages) return items;
      page += 1;
    }
  }

  #tunnelName(hostId: string): string {
    return `${this.#tunnelPrefix}-${hostId}`;
  }

  #hostname(hostId: string): string {
    return `${hostId}.${this.#hostsSuffix}`;
  }

  #hostIdFromTunnelName(name: string): string | null {
    const prefix = `${this.#tunnelPrefix}-`;
    if (!name.startsWith(prefix)) return null;
    const hostId = name.slice(prefix.length);
    return HOST_ID_PATTERN.test(hostId) ? hostId : null;
  }
}

const HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST_ID_MAX_LENGTH = 63;

function normalizeSuffix(value: string): string {
  const suffix = value.toLowerCase().replace(/^\.+/u, "").replace(/\.+$/u, "");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(suffix)) {
    throw new TunnelProvisionError("Cloudflare hosts suffix is not a DNS zone.");
  }
  return suffix;
}

function normalizePrefix(value: string): string {
  const prefix = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(prefix)) {
    throw new TunnelProvisionError("Cloudflare tunnel prefix is not a DNS label.");
  }
  return prefix;
}

function assertHostId(hostId: string): string {
  if (hostId.length > HOST_ID_MAX_LENGTH || !HOST_ID_PATTERN.test(hostId)) {
    throw new TunnelProvisionError("Host id is not a valid tunnel label.");
  }
  return hostId;
}

function assertOriginPort(originPort: number): void {
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65_535) {
    throw new TunnelProvisionError("Tunnel origin port is invalid.");
  }
}

function tunnelTarget(tunnelId: string): string {
  return `${tunnelId.toLowerCase()}${TUNNEL_TARGET_SUFFIX}`;
}

function isTunnelTarget(content: string): boolean {
  const lower = content.toLowerCase();
  return lower.length > TUNNEL_TARGET_SUFFIX.length && lower.endsWith(TUNNEL_TARGET_SUFFIX);
}

function isCname(record: CloudflareDnsRecord): boolean {
  return record.type.toUpperCase() === "CNAME";
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

async function attempt(
  errors: Array<unknown>,
  run: () => Promise<unknown>,
  ignore?: (error: unknown) => boolean,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (ignore?.(error) === true) return;
    errors.push(error);
  }
}

function toProvisionError(error: unknown): TunnelProvisionError {
  if (error instanceof TunnelProvisionError) return error;
  if (error instanceof CloudflareApiError) {
    // Upstream Cloudflare failures surface to hosts as a retryable bad gateway.
    return new TunnelProvisionError(error.message, {
      status: error.retryable ? 502 : error.status,
      retryable: error.retryable,
    });
  }
  return new TunnelProvisionError("Cloudflare tunnel provisioning failed.");
}
