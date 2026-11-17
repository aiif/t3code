// @effect-diagnostics nodeBuiltinImport:off globalProcessRuntime:off no-global-process-runtime:off globalConsole:off -- Standalone build-time downloader outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Keep in step with CLOUDFLARED_VERSION and CLOUDFLARED_RELEASE_ASSETS in
// packages/shared/src/relayClient.ts: the desktop bundle must carry the build the host pins.
const VERSION = "2026.10.4";
const ASSETS = {
  "win-x64": {
    asset: "cloudflared-windows-amd64.exe",
    checksum: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    executable: "cloudflared.exe",
    archive: false,
  },
  // Cloudflare publishes no Windows ARM64 build; Windows 11 on ARM runs this x64 binary under emulation.
  "win-arm64": {
    asset: "cloudflared-windows-amd64.exe",
    checksum: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    executable: "cloudflared.exe",
    archive: false,
  },
  "mac-arm64": {
    asset: "cloudflared-darwin-arm64.tgz",
    checksum: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
    executable: "cloudflared",
    archive: true,
  },
  "mac-x64": {
    asset: "cloudflared-darwin-amd64.tgz",
    checksum: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d",
    executable: "cloudflared",
    archive: true,
  },
  "linux-x64": {
    asset: "cloudflared-linux-amd64",
    checksum: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
    executable: "cloudflared",
    archive: false,
  },
  "linux-arm64": {
    asset: "cloudflared-linux-arm64",
    checksum: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6",
    executable: "cloudflared",
    archive: false,
  },
};

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function megabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function findFile(directory, fileName) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await NodeFSP.readdir(current, { withFileTypes: true })) {
      const entryPath = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === fileName) {
        return entryPath;
      }
    }
  }
  return null;
}

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const platform = arg("platform", "win");
const arch = arg("arch", "x64");
const outDir = arg("out", "apps/desktop/resources/cloudflared");
const required = process.argv.includes("--required");
const force = process.argv.includes("--force");
const target = ASSETS[`${platform}-${arch}`];

if (!target) {
  if (required) {
    console.error(`[cloudflared] No pinned cloudflared ${VERSION} build for ${platform}-${arch}.`);
    process.exit(1);
  }
  console.log(`[cloudflared] Skipping ${platform}-${arch}; no pinned build.`);
  process.exit(0);
}

const destinationDir = NodePath.join(outDir, `${platform}-${arch}`);
const destination = NodePath.join(destinationDir, target.executable);
if (!force && NodeFS.existsSync(destination)) {
  console.log(`[cloudflared] Using bundled ${platform}-${arch} binary at ${destination}`);
  process.exit(0);
}

const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${target.asset}`;
const work = NodePath.join(NodeOS.tmpdir(), `t3-cloudflared-${process.pid}-${Date.now()}`);
await NodeFSP.mkdir(work, { recursive: true });
try {
  console.log(`[cloudflared] Downloading ${target.asset} (${VERSION})`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== target.checksum) {
    throw new Error(
      `Checksum mismatch for ${target.asset}: expected ${target.checksum}, got ${digest}.`,
    );
  }

  let source;
  if (target.archive) {
    const archivePath = NodePath.join(work, target.asset);
    await NodeFSP.writeFile(archivePath, bytes);
    const extracted = NodePath.join(work, "extracted");
    await NodeFSP.mkdir(extracted, { recursive: true });
    NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", extracted], {
      stdio: "inherit",
    });
    const extractedExecutable = await findFile(extracted, target.executable);
    if (extractedExecutable === null) {
      throw new Error(`Extracted ${target.asset} does not contain ${target.executable}.`);
    }
    source = extractedExecutable;
  } else {
    source = NodePath.join(work, target.executable);
    await NodeFSP.writeFile(source, bytes);
  }

  await NodeFSP.mkdir(destinationDir, { recursive: true });
  await NodeFSP.copyFile(source, destination);
  if (platform !== "win") await NodeFSP.chmod(destination, 0o755);
  const { size } = await NodeFSP.stat(destination);
  console.log(`[cloudflared] Bundled ${destination} (${megabytes(size)})`);
} finally {
  await NodeFSP.rm(work, { recursive: true, force: true }).catch(() => undefined);
}
