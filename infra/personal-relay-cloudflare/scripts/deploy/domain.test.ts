import { describe, expect, it } from "vite-plus/test";

import { hostZoneCandidates, DeployDomainError, validateHostsDomain } from "./domain.ts";

describe("hosts domain validation", () => {
  it("lists every candidate zone name, longest first", () => {
    expect(hostZoneCandidates("relay.eu.example.com")).toEqual([
      "relay.eu.example.com",
      "eu.example.com",
      "example.com",
    ]);
    expect(hostZoneCandidates("example.com")).toEqual(["example.com"]);
  });

  it("accepts a zone apex as a one-level suffix", () => {
    expect(
      validateHostsDomain({
        hostsDomain: "example.com",
        zoneNames: ["example.com"],
        allowMultiLevel: false,
      }),
    ).toEqual({ hostsDomain: "example.com", zoneName: "example.com", multiLevel: false });
  });

  it("accepts a sub-zone that is itself a Cloudflare zone", () => {
    expect(
      validateHostsDomain({
        hostsDomain: "t3.example.com",
        zoneNames: ["t3.example.com", "example.com"],
        allowMultiLevel: false,
      }),
    ).toEqual({ hostsDomain: "t3.example.com", zoneName: "t3.example.com", multiLevel: false });
  });

  it("rejects a suffix below a zone without --allow-multi-level", () => {
    expect(() =>
      validateHostsDomain({
        hostsDomain: "t3.example.com",
        zoneNames: ["example.com"],
        allowMultiLevel: false,
      }),
    ).toThrow(/ACM\/Total TLS/u);
  });

  it("allows a deeper suffix only when asked for", () => {
    expect(
      validateHostsDomain({
        hostsDomain: "t3.example.com",
        zoneNames: ["example.com"],
        allowMultiLevel: true,
      }),
    ).toEqual({ hostsDomain: "t3.example.com", zoneName: "example.com", multiLevel: true });
  });

  it("rejects a domain that is not in the account", () => {
    expect(() =>
      validateHostsDomain({
        hostsDomain: "elsewhere.test",
        zoneNames: ["example.com"],
        allowMultiLevel: true,
      }),
    ).toThrow(DeployDomainError);
  });
});
