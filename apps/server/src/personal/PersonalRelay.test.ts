import { describe, expect, it } from "@effect/vitest";
import type { PersonalRelayState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  type FrpRegistration,
  PersonalRelayRequestError,
  renderFrpcConfig,
  superviseRelay,
} from "./PersonalRelay.ts";
const registration = (overrides: Partial<FrpRegistration> = {}): FrpRegistration => ({
  hostId: "abcdef123456",
  hostToken: "abcdef123456.signature",
  environmentId: "env-home",
  label: "Home",
  publicUrl: "https://abcdef123456.t3.example.test",
  frp: {
    serverAddr: "relay.example.test",
    serverPort: 7001,
    authToken: "frp-token",
    domain: "abcdef123456.t3.example.test",
  },
  heartbeatIntervalMs: 30_000,
  ...overrides,
});

const initialState: PersonalRelayState = {
  enabled: true,
  relayUrl: "https://t3.example.test",
  hostId: null,
  publicUrl: null,
  label: "Home",
  online: false,
  lastError: null,
};

describe("frpc configuration", () => {
  it("points the proxy at loopback with the registered vhost domain", () => {
    const contents = renderFrpcConfig({
      serverAddr: "relay.example.test",
      serverPort: 7001,
      authToken: "secret-token",
      domain: "abcdef123456.t3.example.test",
      localPort: 3773,
    });

    expect(contents).toContain('serverAddr = "relay.example.test"');
    expect(contents).toContain("serverPort = 7001");
    expect(contents).toContain('auth.token = "secret-token"');
    expect(contents).toContain('localIP = "127.0.0.1"');
    expect(contents).toContain("localPort = 3773");
    expect(contents).toContain('customDomains = ["abcdef123456.t3.example.test"]');
    expect(contents).toContain('name = "t3-abcdef123456"');
  });
});

interface SupervisorHarness {
  readonly deps: Parameters<typeof superviseRelay>[0];
  readonly registers: Ref.Ref<number>;
  readonly heartbeats: Ref.Ref<number>;
  readonly kills: Ref.Ref<number>;
  readonly writes: Ref.Ref<ReadonlyArray<string>>;
  readonly statuses: Ref.Ref<ReadonlyArray<PersonalRelayState>>;
  readonly spawnObserved: Deferred.Deferred<void>;
  readonly exit: Deferred.Deferred<void>;
  readonly heartbeatSeen: Deferred.Deferred<void>;
  readonly secondSpawn: Deferred.Deferred<void>;
  readonly offlineSeen: Deferred.Deferred<void>;
  readonly heartbeatFailure: Ref.Ref<PersonalRelayRequestError | null>;
}

const makeHarness = Effect.gen(function* () {
  const registers = yield* Ref.make(0);
  const heartbeats = yield* Ref.make(0);
  const kills = yield* Ref.make(0);
  const writes = yield* Ref.make<ReadonlyArray<string>>([]);
  const statuses = yield* Ref.make<ReadonlyArray<PersonalRelayState>>([initialState]);
  const current = yield* Ref.make(initialState);
  const spawnObserved = yield* Deferred.make<void>();
  const secondSpawn = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<void>();
  const heartbeatSeen = yield* Deferred.make<void>();
  const offlineSeen = yield* Deferred.make<void>();
  const heartbeatFailure = yield* Ref.make<PersonalRelayRequestError | null>(null);

  const deps: Parameters<typeof superviseRelay>[0] = {
    label: "Home",
    register: () =>
      Ref.updateAndGet(registers, (count) => count + 1).pipe(Effect.as(registration())),
    heartbeat: () =>
      Ref.get(heartbeatFailure).pipe(
        Effect.flatMap((failure) =>
          failure === null
            ? Ref.update(heartbeats, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(heartbeatSeen, undefined)),
                Effect.asVoid,
              )
            : Effect.fail(failure),
        ),
      ),
    writeConfig: (value) => Ref.update(writes, (all) => [...all, value.hostId]),
    spawnFrpc: () =>
      Effect.acquireRelease(
        Ref.updateAndGet(registers, (count) => count).pipe(
          Effect.flatMap((count) =>
            count > 1
              ? Deferred.succeed(secondSpawn, undefined)
              : Deferred.succeed(spawnObserved, undefined),
          ),
          Effect.as({ exited: Deferred.await(exit), lastError: Effect.succeed("") }),
        ),
        () => Ref.update(kills, (count) => count + 1),
      ),
    updateStatus: (update) =>
      Ref.get(current).pipe(
        Effect.flatMap((previous) => {
          const next = update(previous);
          return Ref.set(current, next).pipe(
            Effect.andThen(Ref.update(statuses, (all) => [...all, next])),
            Effect.andThen(next.online ? Effect.void : Deferred.succeed(offlineSeen, undefined)),
          );
        }),
      ),
  };

  return {
    deps,
    registers,
    heartbeats,
    kills,
    writes,
    statuses,
    spawnObserved,
    secondSpawn,
    exit,
    heartbeatSeen,
    offlineSeen,
    heartbeatFailure,
  } satisfies SupervisorHarness;
});

it.effect("registers, writes frpc.toml, and heartbeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* superviseRelay(harness.deps).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Deferred.await(harness.spawnObserved);
      expect(yield* Ref.get(harness.registers)).toBe(1);
      expect(yield* Ref.get(harness.writes)).toEqual(["abcdef123456"]);
      expect((yield* Ref.get(harness.statuses)).at(-1)?.online).toBe(true);

      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(harness.heartbeatSeen);
      expect(yield* Ref.get(harness.heartbeats)).toBe(1);

      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(harness.kills)).toBeGreaterThan(0);
    }),
  ),
);

it.effect("restarts registration when frpc exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* superviseRelay(harness.deps).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Deferred.await(harness.spawnObserved);
      yield* Deferred.succeed(harness.exit, undefined);
      yield* Deferred.await(harness.offlineSeen);
      expect((yield* Ref.get(harness.statuses)).at(-1)).toMatchObject({ online: false });

      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(harness.secondSpawn);
      expect(yield* Ref.get(harness.registers)).toBe(2);
      // The fake child exits at once, so only registration restart is asserted here;
      // the online flag is covered by the first test.
      expect(yield* Ref.get(harness.writes)).toHaveLength(2);

      yield* Fiber.interrupt(fiber);
    }),
  ),
);

it.effect("registers again when the registry rejects the host token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(
        harness.heartbeatFailure,
        new PersonalRelayRequestError({
          operation: "heartbeat",
          detail: "Relay answered 401.",
          status: 401,
        }),
      );
      const fiber = yield* superviseRelay(harness.deps).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Deferred.await(harness.spawnObserved);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(harness.offlineSeen);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(harness.secondSpawn);
      expect(yield* Ref.get(harness.registers)).toBe(2);

      yield* Fiber.interrupt(fiber);
    }),
  ),
);
