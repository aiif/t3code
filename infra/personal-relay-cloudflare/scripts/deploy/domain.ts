export class DeployDomainError extends Error {
  override name = "DeployDomainError";
}

export interface HostsDomainCheck {
  readonly hostsDomain: string;
  readonly zoneName: string;
  readonly multiLevel: boolean;
}

/** Every zone name that could serve `hostsDomain`, longest first. */
export function hostZoneCandidates(hostsDomain: string): ReadonlyArray<string> {
  const labels = hostsDomain.split(".").filter((label) => label !== "");
  const candidates: Array<string> = [];
  for (let start = 0; start < labels.length - 1; start += 1) {
    candidates.push(labels.slice(start).join("."));
  }
  return candidates;
}

/**
 * Universal SSL covers exactly one label below a zone. A suffix that is deeper
 * than the zone needs ACM/Total TLS, so it only passes when asked for.
 */
export function validateHostsDomain(input: {
  readonly hostsDomain: string;
  readonly zoneNames: ReadonlyArray<string>;
  readonly allowMultiLevel: boolean;
}): HostsDomainCheck {
  const hostsDomain = input.hostsDomain.trim().toLowerCase().replace(/^\.+/u, "");
  const zones = input.zoneNames
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name === hostsDomain || hostsDomain.endsWith(`.${name}`))
    .sort((left, right) => right.length - left.length);

  const zoneName = zones[0];
  if (zoneName === undefined) {
    throw new DeployDomainError(
      `--hosts-domain ${hostsDomain} is not a Cloudflare zone in this account. Add the zone first, or use --mode quick.`,
    );
  }
  if (zoneName === hostsDomain) {
    return { hostsDomain, zoneName, multiLevel: false };
  }
  if (!input.allowMultiLevel) {
    throw new DeployDomainError(
      `--hosts-domain ${hostsDomain} is below the ${zoneName} zone, so hostnames would be two labels deep and need ACM/Total TLS. Add ${hostsDomain} as its own zone, or pass --allow-multi-level.`,
    );
  }
  return { hostsDomain, zoneName, multiLevel: true };
}

export function isDnsLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
