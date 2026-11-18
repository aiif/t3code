import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  MAX_RELAY_PROFILES,
  type PersonalRelayProfile,
  clearRelayRegistration,
  readRelayProfiles,
  relayKeyFor,
  relayProfileSummaries,
  removeRelayProfile,
  upsertRelayProfile,
  writeRelayProfiles,
} from "./relayProfiles.ts";

const NOW = "2026-11-18T00:00:00.000Z";

it("upserts a relay, keeps its secrets, and moves it to the front", () => {
  const first = upsertRelayProfile([], {
    relayUrl: "https://relay.example.test/",
    relayKey: "enrollment-key",
    hostId: "abc123def456",
    hostKey: "host-key-secret",
    publicUrl: "https://abc123def456.relay.example.test",
    now: "2026-11-17T00:00:00.000Z",
  });
  const second = upsertRelayProfile(first, {
    relayUrl: "https://other.example.test",
    now: NOW,
  });
  const saved = upsertRelayProfile(second, {
    relayUrl: "https://relay.example.test",
    publicUrl: "https://abc123def456.relay.example.test/",
    now: NOW,
  });

  expect(saved.map((profile) => profile.relayUrl)).toEqual([
    "https://relay.example.test",
    "https://other.example.test",
  ]);
  expect(saved[0]).toMatchObject({
    relayKey: "enrollment-key",
    hostId: "abc123def456",
    hostKey: "host-key-secret",
    publicUrl: "https://abc123def456.relay.example.test/",
    updatedAt: NOW,
  });
  expect(relayKeyFor(saved, "https://relay.example.test/")).toBe("enrollment-key");
});

it("never includes credentials in summaries", () => {
  const profiles: ReadonlyArray<PersonalRelayProfile> = [
    {
      relayUrl: "https://relay.example.test",
      relayKey: "enrollment-key",
      hostId: "abc123def456",
      hostKey: "host-key-secret",
      publicUrl: "https://abcdef123456.relay.example.test",
      updatedAt: NOW,
    },
  ];
  const serialized = JSON.stringify(relayProfileSummaries(profiles));
  expect(serialized).not.toContain("enrollment-key");
  expect(serialized).not.toContain("host-key-secret");
  expect(relayProfileSummaries(profiles)[0]).toMatchObject({
    relayUrl: "https://relay.example.test",
    hasRelayKey: true,
    hostId: "abc123def456",
  });
});

it("forgets one relay and keeps the rest", () => {
  const profiles = [
    { relayUrl: "https://a.example.test", updatedAt: NOW },
    { relayUrl: "https://b.example.test", updatedAt: NOW },
  ];
  expect(removeRelayProfile(profiles, "https://a.example.test/")).toEqual([
    { relayUrl: "https://b.example.test", updatedAt: NOW },
  ]);
});

it("clears an invalidated registration but keeps the enrollment key", () => {
  const profiles = [
    {
      relayUrl: "https://relay.example.test",
      relayKey: "enrollment-key",
      hostId: "abc123def456",
      hostKey: "host-key-secret",
      publicUrl: "https://abcdef123456.relay.example.test",
      updatedAt: "2026-11-17T00:00:00.000Z",
    },
  ];
  expect(clearRelayRegistration(profiles, "https://relay.example.test/", NOW)).toEqual([
    {
      relayUrl: "https://relay.example.test",
      relayKey: "enrollment-key",
      updatedAt: NOW,
    },
  ]);
});

it("caps the saved relay list", () => {
  let profiles: ReadonlyArray<PersonalRelayProfile> = [];
  for (let index = 0; index < MAX_RELAY_PROFILES + 5; index += 1) {
    profiles = upsertRelayProfile(profiles, {
      relayUrl: `https://relay-${index}.example.test`,
      now: NOW,
    });
  }
  expect(profiles).toHaveLength(MAX_RELAY_PROFILES);
  expect(profiles[0]?.relayUrl).toBe(`https://relay-${MAX_RELAY_PROFILES + 4}.example.test`);
});

it.layer(NodeServices.layer)("personal relay profiles file", (it) => {
  it.effect("round-trips an owner-only file and treats malformed state as empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-relays-" });
      const profiles = upsertRelayProfile([], {
        relayUrl: "https://relay.example.test",
        relayKey: "enrollment-key",
        hostId: "abc123def456",
        hostKey: "host-key-secret",
        now: NOW,
      });
      yield* writeRelayProfiles({ stateDir, profiles });
      expect(yield* readRelayProfiles({ stateDir })).toEqual(profiles);

      const file = `${stateDir}/personal/relays.json`;
      yield* fs.writeFileString(file, "{not json");
      expect(yield* readRelayProfiles({ stateDir })).toEqual([]);
    }),
  );
});
