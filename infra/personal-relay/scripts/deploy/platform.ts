/* oxlint-disable t3code/no-global-process-runtime -- The standalone deploy CLI needs the host platform. */
// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

export const isWindows = process.platform === "win32";

function isPublicAddress(address: string): boolean {
  return (
    address !== "0.0.0.0" &&
    address !== "::" &&
    !address.startsWith("127.") &&
    !address.startsWith("169.254.") &&
    !address.toLowerCase().startsWith("fe80:") &&
    !address.startsWith("::1")
  );
}

export function publicAddresses(): ReadonlyArray<string> {
  const addresses: Array<string> = [];
  const interfaces: NodeJS.Dict<NodeOS.NetworkInterfaceInfo[]> = NodeOS.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (entry.internal || !isPublicAddress(entry.address)) continue;
      const family = String(entry.family);
      if (family === "IPv4" || family === "IPv6") addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

export function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
