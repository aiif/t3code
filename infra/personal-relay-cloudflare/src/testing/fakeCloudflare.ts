export interface FakeTunnel {
  readonly id: string;
  name: string;
  configSrc: "cloudflare" | "local";
  ingress: ReadonlyArray<Record<string, unknown>>;
  readonly token: string;
  readonly createdAt: string;
}

export interface FakeDnsRecord {
  readonly id: string;
  readonly zoneId: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface FakeCloudflareCall {
  readonly method: string;
  readonly path: string;
}

export interface FakeFailure {
  status: number;
  remaining: number;
  readonly method?: string | undefined;
  readonly pathIncludes?: string | undefined;
  readonly message: string;
}

export interface FakeCloudflareState {
  readonly accountId: string;
  readonly zoneId: string;
  readonly tunnels: Map<string, FakeTunnel>;
  readonly dnsRecords: Map<string, FakeDnsRecord>;
  readonly calls: Array<FakeCloudflareCall>;
  readonly failures: Array<FakeFailure>;
}

export interface FakeCloudflare {
  readonly fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  readonly state: FakeCloudflareState;
  failNext(
    status: number,
    options?: {
      readonly method?: string;
      readonly pathIncludes?: string;
      readonly times?: number;
      readonly message?: string;
    },
  ): void;
}

const API_PREFIX = "/client/v4";

export function createFakeCloudflare(options?: {
  readonly accountId?: string;
  readonly zoneId?: string;
}): FakeCloudflare {
  const state: FakeCloudflareState = {
    accountId: options?.accountId ?? "account-test",
    zoneId: options?.zoneId ?? "zone-test",
    tunnels: new Map(),
    dnsRecords: new Map(),
    calls: [],
    failures: [],
  };
  let nextId = 1;

  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    state.calls.push({ method, path: `${path}${url.search}` });

    const failureIndex = state.failures.findIndex(
      (failure) =>
        failure.remaining > 0 &&
        (failure.method === undefined || failure.method === method) &&
        (failure.pathIncludes === undefined || path.includes(failure.pathIncludes)),
    );
    if (failureIndex !== -1) {
      const failure = state.failures[failureIndex]!;
      failure.remaining -= 1;
      return apiError(failure.status, failure.message);
    }

    if (!path.startsWith(API_PREFIX)) return apiError(404, "Unknown path.");
    const route = path.slice(API_PREFIX.length);
    const body = await readBody(request);

    if (method === "GET" && route === "/user/tokens/verify") {
      return apiOk({ id: "token-test", status: "active" });
    }
    if (method === "GET" && route === `/accounts/${state.accountId}`) {
      return apiOk({ id: state.accountId, name: "Test Account" });
    }
    if (method === "GET" && route === `/zones/${state.zoneId}`) {
      return apiOk({ id: state.zoneId, name: "example.test", status: "active" });
    }

    const tunnelList = new RegExp(`^/accounts/([^/]+)/cfd_tunnel$`, "u").exec(route);
    if (tunnelList !== null && method === "GET") {
      const name = url.searchParams.get("name");
      const tunnels = [...state.tunnels.values()].filter(
        (tunnel) => name === null || tunnel.name === name,
      );
      return apiOk(tunnels);
    }
    if (tunnelList !== null && method === "POST") {
      const name = typeof body["name"] === "string" ? body["name"] : null;
      if (name === null) return apiError(400, "name is required.");
      const tunnel: FakeTunnel = {
        id: `tunnel-${nextId++}`,
        name,
        configSrc: body["config_src"] === "local" ? "local" : "cloudflare",
        ingress: [],
        token: `fake-tunnel-token-${nextId}`,
        createdAt: new Date(0).toISOString(),
      };
      state.tunnels.set(tunnel.id, tunnel);
      return apiOk(tunnel);
    }

    const tunnelRoute =
      /^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)(\/configurations|\/token|\/connections)?$/u.exec(
        route,
      );
    if (tunnelRoute !== null) {
      const tunnel = state.tunnels.get(tunnelRoute[2]!);
      if (tunnel === undefined) return apiError(404, "Tunnel not found.");
      const action = tunnelRoute[3];
      if (method === "GET" && action === undefined) return apiOk(tunnel);
      if (method === "PUT" && action === "/configurations") {
        const config = body["config"];
        const ingress =
          typeof config === "object" &&
          config !== null &&
          Array.isArray((config as Record<string, unknown>)["ingress"])
            ? ((config as Record<string, unknown>)["ingress"] as ReadonlyArray<
                Record<string, unknown>
              >)
            : [];
        tunnel.ingress = ingress;
        return apiOk(tunnel);
      }
      if (method === "GET" && action === "/token") return apiOk(tunnel.token);
      if (method === "DELETE" && action === "/connections") return apiOk({});
      if (method === "DELETE" && action === undefined) {
        state.tunnels.delete(tunnel.id);
        return apiOk({ id: tunnel.id });
      }
    }

    const dnsList = new RegExp(`^/zones/([^/]+)/dns_records$`, "u").exec(route);
    if (dnsList !== null && method === "GET") {
      const name = url.searchParams.get("name");
      const records = [...state.dnsRecords.values()].filter(
        (record) => name === null || record.name === name,
      );
      return apiOk(records);
    }
    if (dnsList !== null && method === "POST") {
      const name = typeof body["name"] === "string" ? body["name"] : null;
      if (name === null) return apiError(400, "name is required.");
      const existing = [...state.dnsRecords.values()].find((record) => record.name === name);
      if (existing !== undefined) {
        return apiError(409, "A record with that name already exists.");
      }
      const record: FakeDnsRecord = {
        id: `dns-${nextId++}`,
        zoneId: dnsList[1]!,
        name,
        type: typeof body["type"] === "string" ? body["type"] : "CNAME",
        content: typeof body["content"] === "string" ? body["content"] : "",
        proxied: body["proxied"] === true,
        ttl: typeof body["ttl"] === "number" ? body["ttl"] : 1,
      };
      state.dnsRecords.set(record.id, record);
      return apiOk(record);
    }

    const dnsRecord = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/u.exec(route);
    if (dnsRecord !== null) {
      const record = state.dnsRecords.get(dnsRecord[2]!);
      if (record === undefined) return apiError(404, "DNS record not found.");
      if (method === "PATCH" || method === "PUT") {
        if (typeof body["name"] === "string") record.name = body["name"];
        if (typeof body["type"] === "string") record.type = body["type"];
        if (typeof body["content"] === "string") record.content = body["content"];
        if (typeof body["proxied"] === "boolean") record.proxied = body["proxied"];
        if (typeof body["ttl"] === "number") record.ttl = body["ttl"];
        return apiOk(record);
      }
      if (method === "DELETE") {
        state.dnsRecords.delete(record.id);
        return apiOk({ id: record.id });
      }
    }

    return apiError(404, `No fake route for ${method} ${route}.`);
  };

  return {
    fetch: fetchImpl,
    state,
    failNext: (status, failureOptions) => {
      state.failures.push({
        status,
        remaining: failureOptions?.times ?? 1,
        method: failureOptions?.method,
        pathIncludes: failureOptions?.pathIncludes,
        message: failureOptions?.message ?? `Injected ${status} failure.`,
      });
    },
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function apiOk(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function apiError(status: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code: status, message }], messages: [], result: null },
    { status },
  );
}
