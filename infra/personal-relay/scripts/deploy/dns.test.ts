import { expect, it } from "vite-plus/test";

import { checkRelayDns } from "./dns.ts";
import type { DnsResolver } from "./types.ts";

function resolver(addresses: {
  readonly base: ReadonlyArray<string>;
  readonly wildcard: ReadonlyArray<string>;
}): DnsResolver {
  return {
    async resolve4(hostname) {
      if (hostname.includes("t3check-"))
        return addresses.wildcard.filter((address) => !address.includes(":"));
      return addresses.base.filter((address) => !address.includes(":"));
    },
    async resolve6(hostname) {
      if (hostname.includes("t3check-"))
        return addresses.wildcard.filter((address) => address.includes(":"));
      return addresses.base.filter((address) => address.includes(":"));
    },
  };
}

it("accepts matching base and wildcard records", async () => {
  const result = await checkRelayDns({
    domain: "relay.example.com",
    publicIp: "203.0.113.10",
    skip: false,
    resolver: resolver({ base: ["203.0.113.10"], wildcard: ["203.0.113.10"] }),
    localAddresses: [],
  });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("203.0.113.10");
});

it("fails when the base or wildcard record is missing", async () => {
  const missingWildcard = await checkRelayDns({
    domain: "relay.example.com",
    publicIp: "203.0.113.10",
    skip: false,
    resolver: resolver({ base: ["203.0.113.10"], wildcard: [] }),
    localAddresses: [],
  });
  expect(missingWildcard.ok).toBe(false);
  expect(missingWildcard.detail).toContain("*.relay.example.com");
  expect(missingWildcard.records).toContain("A     *.relay.example.com      203.0.113.10");

  const missingBase = await checkRelayDns({
    domain: "relay.example.com",
    publicIp: "203.0.113.10",
    skip: false,
    resolver: resolver({ base: [], wildcard: ["203.0.113.10"] }),
    localAddresses: [],
  });
  expect(missingBase.ok).toBe(false);
  expect(missingBase.detail).toContain("relay.example.com");
});

it("warns but continues when DNS does not match the expected address", async () => {
  const result = await checkRelayDns({
    domain: "relay.example.com",
    publicIp: "203.0.113.10",
    skip: false,
    resolver: resolver({ base: ["198.51.100.20"], wildcard: ["198.51.100.20"] }),
    localAddresses: [],
  });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("not both relay.example.com and *.relay.example.com");
});

it("can skip the check", async () => {
  const result = await checkRelayDns({
    domain: "relay.example.com",
    publicIp: null,
    skip: true,
    resolver: resolver({ base: [], wildcard: [] }),
    localAddresses: ["203.0.113.10"],
  });
  expect(result).toEqual({
    ok: true,
    skipped: true,
    baseAddresses: [],
    wildcardAddresses: [],
    expectedAddresses: ["203.0.113.10"],
    records: [
      "A     relay.example.com        203.0.113.10",
      "A     *.relay.example.com      203.0.113.10",
      "AAAA  relay.example.com        <your VPS IPv6, optional>",
      "AAAA  *.relay.example.com      <your VPS IPv6, optional>",
    ],
    detail: "DNS check skipped.",
  });
});
