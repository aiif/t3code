// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";

import type { DnsCheckResult, DnsResolver } from "./types.ts";

export const systemDnsResolver: DnsResolver = {
  async resolve4(hostname) {
    try {
      return await NodeDnsPromises.resolve4(hostname);
    } catch {
      return [];
    }
  },
  async resolve6(hostname) {
    try {
      return await NodeDnsPromises.resolve6(hostname);
    } catch {
      return [];
    }
  },
};

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function hasIntersection(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function recordLines(input: {
  readonly domain: string;
  readonly expected: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const ipv4 = input.expected.find((value) => !value.includes(":"));
  const ipv6 = input.expected.find((value) => value.includes(":"));
  const a = ipv4 ?? "<your VPS IPv4>";
  const aaaa = ipv6 ?? "<your VPS IPv6, optional>";
  return [
    `A     ${input.domain}        ${a}`,
    `A     *.${input.domain}      ${a}`,
    `AAAA  ${input.domain}        ${aaaa}`,
    `AAAA  *.${input.domain}      ${aaaa}`,
  ];
}

export async function checkRelayDns(input: {
  readonly domain: string;
  readonly publicIp: string | null;
  readonly skip: boolean;
  readonly resolver: DnsResolver;
  readonly localAddresses: ReadonlyArray<string>;
}): Promise<DnsCheckResult> {
  const expectedAddresses = unique(
    input.publicIp === null ? input.localAddresses : [input.publicIp],
  );
  const records = recordLines({ domain: input.domain, expected: expectedAddresses });

  if (input.skip) {
    return {
      ok: true,
      skipped: true,
      baseAddresses: [],
      wildcardAddresses: [],
      expectedAddresses,
      records,
      detail: "DNS check skipped.",
    };
  }

  const wildcardProbe = `t3check-${NodeCrypto.randomBytes(4).toString("hex")}.${input.domain}`;
  const [base4, base6, wildcard4, wildcard6] = await Promise.all([
    input.resolver.resolve4(input.domain),
    input.resolver.resolve6(input.domain),
    input.resolver.resolve4(wildcardProbe),
    input.resolver.resolve6(wildcardProbe),
  ]);
  const baseAddresses = unique([...base4, ...base6]);
  const wildcardAddresses = unique([...wildcard4, ...wildcard6]);

  if (baseAddresses.length === 0 || wildcardAddresses.length === 0) {
    const missing = [
      baseAddresses.length === 0 ? input.domain : null,
      wildcardAddresses.length === 0 ? `*.${input.domain}` : null,
    ].filter((value): value is string => value !== null);
    return {
      ok: false,
      skipped: false,
      baseAddresses,
      wildcardAddresses,
      expectedAddresses,
      records,
      detail: `DNS is not ready for ${missing.join(" and ")}. Add the records below, then rerun.`,
    };
  }

  const baseMatches = hasIntersection(baseAddresses, expectedAddresses);
  const wildcardMatches = hasIntersection(wildcardAddresses, expectedAddresses);
  if (expectedAddresses.length > 0 && (!baseMatches || !wildcardMatches)) {
    return {
      ok: true,
      skipped: false,
      baseAddresses,
      wildcardAddresses,
      expectedAddresses,
      records,
      detail: `DNS resolves, but not both ${input.domain} and *.${input.domain} point to ${expectedAddresses.join(", ")}. Check the VPS public address or pass --public-ip.`,
    };
  }

  return {
    ok: true,
    skipped: false,
    baseAddresses,
    wildcardAddresses,
    expectedAddresses,
    records,
    detail: `DNS resolves to ${[...new Set([...baseAddresses, ...wildcardAddresses])].join(", ")}.`,
  };
}
