import { describe, expect, it } from "vite-plus/test";

import {
  buildDeployConfig,
  DeployConfigError,
  parseJsonc,
  serializeDeployConfig,
  stripJsonComments,
} from "./config.ts";

const TEMPLATE = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "template",
  main: "src/worker.ts",
  compatibility_date: "2026-10-01",
  assets: {
    directory: "../../apps/web/dist",
    not_found_handling: "single-page-application",
    run_worker_first: ["/v1/*"],
  },
  durable_objects: {
    bindings: [{ name: "REGISTRY", class_name: "RegistryDurableObject" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["RegistryDurableObject"] }],
  observability: { enabled: true },
  vars: { T3CODE_TUNNEL_MODE: "auto" },
};

describe("deploy config", () => {
  it("strips comments without touching URLs inside strings", () => {
    const text = `{
      // A comment.
      "url": "https://example.com/a//b",
      "nested": { /* block */ "value": 1 }
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: "https://example.com/a//b",
      nested: { value: 1 },
    });
  });

  it("rejects invalid templates", () => {
    expect(() => parseJsonc("{", "template")).toThrow(DeployConfigError);
    expect(() => parseJsonc("[]", "template")).toThrow(DeployConfigError);
  });

  it("generates a workers.dev config from the template", () => {
    const config = buildDeployConfig({
      template: TEMPLATE,
      workerName: "t3cf",
      main: "/pkg/src/worker.ts",
      portalDirectory: "/repo/apps/web/dist",
      vars: { T3CODE_TUNNEL_MODE: "quick", TUNNEL_PREFIX: "t3cf" },
      relayDomain: null,
    });

    expect(config.$schema).toBeUndefined();
    expect(config.name).toBe("t3cf");
    expect(config.main).toBe("/pkg/src/worker.ts");
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.assets).toEqual({
      directory: "/repo/apps/web/dist",
      not_found_handling: "single-page-application",
      run_worker_first: ["/v1/*"],
    });
    expect(config.vars).toEqual({ T3CODE_TUNNEL_MODE: "quick", TUNNEL_PREFIX: "t3cf" });
    expect(config.migrations).toEqual(TEMPLATE.migrations);
  });

  it("turns off workers.dev for a custom relay domain", () => {
    const config = buildDeployConfig({
      template: TEMPLATE,
      workerName: "t3cf",
      main: "worker.js",
      portalDirectory: "portal",
      vars: {},
      relayDomain: "relay.example.com",
    });

    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([{ pattern: "relay.example.com", custom_domain: true }]);
  });

  it("serializes a config that parses back", () => {
    const text = serializeDeployConfig({ name: "t3cf", vars: {} });
    expect(text.startsWith("// Generated")).toBe(true);
    expect(parseJsonc(text, "generated").name).toBe("t3cf");
  });
});
