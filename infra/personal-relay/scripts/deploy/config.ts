import type { RelayState, TlsConfig } from "./types.ts";

export interface RenderOptions {
  readonly redactSecrets?: boolean;
}

function redact(value: string, options: RenderOptions): string {
  return options.redactSecrets ? "<generated>" : value;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function caddyEmailLine(state: RelayState): string {
  return state.email === null ? "" : `\temail ${state.email}\n`;
}

function caddyTlsBlock(tls: TlsConfig): string {
  if (tls.mode === "files") {
    return `\ttls /certs/fullchain.pem /certs/privkey.pem`;
  }
  return `\ttls {\n\t\ton_demand\n\t}`;
}

function caddyOnDemandBlock(tls: TlsConfig): string {
  if (tls.mode !== "on-demand") return "";
  return `\ton_demand_tls {\n\t\task http://registry:8787/internal/tls/ask\n\t}\n`;
}

export function renderCompose(state: RelayState): string {
  const tlsVolume = state.tls.mode === "files" ? `      - ./certs:/certs:ro\n` : "";
  return `services:
  registry:
    image: ${state.images.node}
    user: "0:0"
    command: ["node", "/app/registry.mjs"]
    working_dir: /app
    restart: unless-stopped
    env_file:
      - ./relay.env
    environment:
      REGISTRY_HOST: 0.0.0.0
      REGISTRY_PORT: "8787"
      REGISTRY_DATA_DIR: /data
    volumes:
      - ./registry:/app:ro
      - ./data:/data
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8787/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  frps:
    image: ${state.images.frps}
    user: "0:0"
    restart: unless-stopped
    command: ["-c", "/etc/frp/frps.toml"]
    volumes:
      - ./frps.toml:/etc/frp/frps.toml:ro
    ports:
      - "7001:7001"
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  caddy:
    image: ${state.images.caddy}
    user: "0:0"
    restart: unless-stopped
    depends_on:
      registry:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./portal:/srv/portal:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
${tlsVolume}    security_opt:
      - no-new-privileges:true
`;
}

export function renderCaddyfile(state: RelayState): string {
  const baseTls =
    state.tls.mode === "files" ? `\ttls /certs/fullchain.pem /certs/privkey.pem\n\n` : "";
  return `{
${caddyEmailLine(state)}${caddyOnDemandBlock(state.tls)}}

https://${state.domain} {
${baseTls}\tencode zstd gzip

	handle /v1/* {
		reverse_proxy registry:8787 {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
		}
	}

	handle /assets/* {
		root * /srv/portal
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	handle /.well-known/* {
		root * /srv/portal
		file_server
	}

	handle {
		root * /srv/portal
		try_files {path} /index.html
		header Cache-Control "no-cache"
		file_server
	}
}

https://*.${state.domain} {
${caddyTlsBlock(state.tls)}
	reverse_proxy frps:8080 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		flush_interval -1
	}
}
`;
}

export function renderFrpsToml(state: RelayState): string {
  return `bindPort = 7001
vhostHTTPPort = 8080
proxyBindAddr = "0.0.0.0"

auth.method = "token"
auth.token = ${tomlString(state.frpAuthToken)}

allowPorts = []

transport.maxPoolCount = 10
userConnTimeout = 10
`;
}

export function renderRelayEnv(state: RelayState, options: RenderOptions = {}): string {
  const subject = state.email === null ? state.portalUrl : `mailto:${state.email}`;
  return `T3CODE_ADMIN_KEY=${redact(state.adminKey, options)}
T3CODE_SECRET_KEY=${redact(state.secretKey, options)}
T3CODE_PORTAL_URL=${state.portalUrl}
FRP_SERVER_ADDR=${state.domain}
FRP_SERVER_PORT=7001
FRP_AUTH_TOKEN=${redact(state.frpAuthToken, options)}
VAPID_SUBJECT=${subject}
REGISTRY_HOST=0.0.0.0
REGISTRY_PORT=8787
REGISTRY_DATA_DIR=/data
`;
}

export function renderPrompt(input: {
  readonly version: string;
  readonly releaseUrl: string;
  readonly packageName: string;
}): string {
  return `You are deploying a T3 Code personal relay natively on this VPS.

1. Download and extract the native bundle:
   ${input.releaseUrl}
2. Read native/AI-DEPLOY.md from the extracted bundle and follow it exactly.
3. Ask me for the relay domain and ACME email before changing anything.
4. Show the preflight results, and stop on any failed check.
5. Do not install Docker. Do not modify unrelated services.

Preserve /opt/t3-relay/deploy.json and /opt/t3-relay/data on upgrades.
This prompt targets ${input.packageName} ${input.version}.
`;
}

export function stackFiles(state: RelayState): ReadonlyArray<{
  readonly path: string;
  readonly contents: string;
  readonly mode: number;
}> {
  return [
    { path: "compose.yaml", contents: renderCompose(state), mode: 0o644 },
    { path: "Caddyfile", contents: renderCaddyfile(state), mode: 0o644 },
    { path: "frps.toml", contents: renderFrpsToml(state), mode: 0o640 },
    { path: "relay.env", contents: renderRelayEnv(state), mode: 0o600 },
  ];
}
