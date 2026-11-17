export interface WranglerRunOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly input?: string | undefined;
}

export interface WranglerRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WranglerRunner {
  run(args: ReadonlyArray<string>, options?: WranglerRunOptions): Promise<WranglerRunResult>;
}

export interface DeploySecrets {
  readonly adminKey: string;
  readonly secretKey: string;
  readonly enrollKey: string;
  readonly cfApiToken?: string | undefined;
}

export interface DeployOptions {
  readonly mode: "auto" | "named" | "quick";
  readonly workerName: string;
  readonly hostsDomain: string | null;
  readonly relayDomain: string | null;
  readonly maxHosts: number;
  readonly dryRun: boolean;
  readonly upgrade: boolean;
  readonly destroy: boolean;
  readonly doctor: boolean;
  readonly yes: boolean;
}

export interface DeployDependencies {
  readonly wrangler: WranglerRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}
