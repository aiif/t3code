import { expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseJsonc, stripTrailingCommas } from "./deploy/config.ts";

const template = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "templates", "wrangler.jsonc"),
  "utf8",
);

it("ships a JSONC Worker template with the v1 route", () => {
  const parsed = parseJsonc(template, "template") as {
    main: string;
    assets: { directory: string; run_worker_first: ReadonlyArray<string> };
    durable_objects: { bindings: ReadonlyArray<{ name: string; class_name: string }> };
    migrations: ReadonlyArray<{ new_sqlite_classes: ReadonlyArray<string> }>;
  };
  expect(parsed.main).toBe("dist/worker/worker.js");
  expect(parsed.assets.directory).toBe("dist/portal");
  expect(parsed.assets.run_worker_first).toContain("/v1");
  expect(parsed.durable_objects.bindings[0]?.class_name).toBe("RegistryDurableObject");
  expect(parsed.migrations[0]?.new_sqlite_classes).toContain("RegistryDurableObject");
});

it("does not strip comma-brace text inside strings", () => {
  expect(JSON.parse(stripTrailingCommas('{"value": ",}", "nested": [1,2,],}'))).toEqual({
    value: ",}",
    nested: [1, 2],
  });
});
