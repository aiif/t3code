import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  clearPersonalHostFile,
  PersonalHostFile,
  readPersonalHostFile,
  writePersonalHostFile,
} from "./hostSharingState.ts";
import { renderFrpcConfig } from "./PersonalRelay.ts";

const host = (overrides: Partial<PersonalHostFile> = {}): PersonalHostFile => ({
  enabled: true,
  paused: false,
  relayUrl: "https://t3.example.test",
  label: "Home PC",
  hostId: "abcdef123456",
  hostKey: "host-key-for-tests-0123456789abcdef",
  hostKeyVersion: 1,
  hostToken: "abcdef123456.host-token",
  publicUrl: "https://abcdef123456.t3.example.test",
  frp: {
    serverAddr: "203.0.113.10",
    serverPort: 7001,
    authToken: "frp-auth-token",
    domain: "abcdef123456.t3.example.test",
  },
  updatedAt: "2026-11-16T00:00:00.000Z",
  ...overrides,
});

it.layer(NodeServices.layer)("personal host state", (it) => {
  it.effect("round-trips the host key in an owner-only state file and clears it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-host-" });
      yield* writePersonalHostFile({ stateDir, state: host() });

      const read = yield* readPersonalHostFile({ stateDir });
      expect(read._tag).toBe("Some");
      if (read._tag === "Some") {
        expect(read.value).toEqual(host());
        expect(read.value.hostKey).toBe("host-key-for-tests-0123456789abcdef");
      }

      yield* clearPersonalHostFile({ stateDir });
      expect((yield* readPersonalHostFile({ stateDir }))._tag).toBe("None");
    }),
  );

  it.effect("treats a malformed state file as unconfigured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-host-bad-" });
      yield* fs.makeDirectory(`${stateDir}/personal`, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/personal/personal-host.json`, "{not json");
      expect((yield* readPersonalHostFile({ stateDir }))._tag).toBe("None");
    }),
  );
});

it("renders one frp proxy for the host subdomain", () => {
  const config = renderFrpcConfig({
    serverAddr: "203.0.113.10",
    serverPort: 7001,
    authToken: "token",
    domain: "abcdef123456.t3.example.test",
    localPort: 3773,
  });
  expect(config).toContain("localPort = 3773");
  expect(config).toContain('customDomains = ["abcdef123456.t3.example.test"]');
  expect(config).toContain('name = "t3-abcdef123456"');
});
