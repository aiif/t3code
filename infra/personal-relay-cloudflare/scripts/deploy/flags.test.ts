import { describe, expect, it } from "vite-plus/test";

import { DeployFlagError, parseDeployFlags } from "./flags.ts";

describe("parseDeployFlags", () => {
  it("defaults to auto mode, the t3cf worker and 20 hosts", () => {
    expect(parseDeployFlags([])).toEqual({
      mode: "auto",
      workerName: "t3cf",
      hostsDomain: null,
      relayDomain: null,
      maxHosts: 20,
      dryRun: false,
      upgrade: false,
      destroy: false,
      doctor: false,
      yes: false,
      secretsFile: null,
      noPortalBuild: false,
      allowMultiLevel: false,
      rotateKeys: false,
      help: false,
    });
  });

  it("accepts space and equals forms and normalizes hostnames", () => {
    const flags = parseDeployFlags([
      "--mode=named",
      "--hosts-domain",
      "Example.COM.",
      "--relay-domain=relay.example.com",
      "--worker-name",
      "HomeRelay",
      "--max-hosts=5",
      "--secrets-file",
      "./secrets.json",
      "--dry-run",
      "--upgrade",
      "--rotate-keys",
    ]);

    expect(flags.mode).toBe("named");
    expect(flags.hostsDomain).toBe("example.com");
    expect(flags.relayDomain).toBe("relay.example.com");
    expect(flags.workerName).toBe("homerelay");
    expect(flags.maxHosts).toBe(5);
    expect(flags.secretsFile).toBe("./secrets.json");
    expect(flags.dryRun).toBe(true);
    expect(flags.upgrade).toBe(true);
    expect(flags.rotateKeys).toBe(true);
  });

  it("accepts the init subcommand used by npx t3cf", () => {
    expect(parseDeployFlags(["init", "--mode", "quick"]).mode).toBe("quick");
  });

  it("rejects unknown options, missing values and invalid numbers", () => {
    expect(() => parseDeployFlags(["--nope"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["--mode"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["--max-hosts", "0"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["--mode", "tunnel"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["--worker-name", "Not A Label"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["deploy"])).toThrow(DeployFlagError);
    expect(() => parseDeployFlags(["--dry-run=yes"])).toThrow(DeployFlagError);
  });
});
