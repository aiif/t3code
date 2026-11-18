export interface CommandOutput {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly input?: string | undefined;
  readonly inheritStdio?: boolean | undefined;
}

export interface CommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export type RuntimeMode = "docker" | "native";

export type TlsMode = "on-demand" | "files";

export interface TlsConfig {
  readonly mode: TlsMode;
  readonly certPath?: string | undefined;
  readonly keyPath?: string | undefined;
}

export interface RelayImages {
  readonly caddy: string;
  readonly frps: string;
  readonly node: string;
}

export interface RelayState {
  readonly version: 1;
  readonly mode: RuntimeMode;
  readonly domain: string;
  readonly portalUrl: string;
  readonly email: string | null;
  readonly adminKey: string;
  readonly secretKey: string;
  readonly frpAuthToken: string;
  readonly tls: TlsConfig;
  readonly images: RelayImages;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeployLayout {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly registrySource: string;
  readonly portalSource: string;
  readonly nativeDirectory: string;
  readonly defaultInstallDir: string;
  readonly releaseUrl: string;
  readonly packageVersion: string;
}

export interface DnsResolver {
  resolve4(hostname: string): Promise<ReadonlyArray<string>>;
  resolve6(hostname: string): Promise<ReadonlyArray<string>>;
}

export interface DnsCheckResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly baseAddresses: ReadonlyArray<string>;
  readonly wildcardAddresses: ReadonlyArray<string>;
  readonly expectedAddresses: ReadonlyArray<string>;
  readonly records: ReadonlyArray<string>;
  readonly detail: string;
}
