// @effect-diagnostics nodeBuiltinImport:off globalProcessRuntime:off no-global-process-runtime:off globalConsole:off -- Standalone build-time downloader outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const VERSION = "0.61.1";
const ASSETS = {
  "win-x64": {
    archive: `frp_${VERSION}_windows_amd64.zip`,
    checksum: "e0094cd0baf03d5ff9ce9739199406871ad8788cf51e766f00ad3a9e7a836f3a",
    executable: "frpc.exe",
  },
  "win-arm64": {
    archive: `frp_${VERSION}_windows_arm64.zip`,
    checksum: "099914b6f66b1d983a9402e3a9a116bccc683c877f6dbfbbb5c0f171b584675f",
    executable: "frpc.exe",
  },
  "mac-arm64": {
    archive: `frp_${VERSION}_darwin_arm64.tar.gz`,
    checksum: "3e65f13a17a284bd6013e6bb6856bc2720074cea6094cc446c1f4c3932154c2d",
    executable: "frpc",
  },
  "mac-x64": {
    archive: `frp_${VERSION}_darwin_amd64.tar.gz`,
    checksum: "403a0ee5e92f083a863d984b7af1e9d70ba2aaa28e87f42f1fe085adf76b8491",
    executable: "frpc",
  },
  "linux-x64": {
    archive: `frp_${VERSION}_linux_amd64.tar.gz`,
    checksum: "bff260b68ca7b1461182a46c4f34e9709ba32764eed30a15dd94ac97f50a2c40",
    executable: "frpc",
  },
  "linux-arm64": {
    archive: `frp_${VERSION}_linux_arm64.tar.gz`,
    checksum: "af6366f2b43920ebfe6235dba6060770399ed1fb18601e5818552bd46a7621f8",
    executable: "frpc",
  },
};

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const platform = arg("platform", "win");
const arch = arg("arch", "x64");
const outDir = arg("out", "apps/desktop/resources/frpc");
const required = process.argv.includes("--required");
const target = ASSETS[`${platform}-${arch}`];

if (!target) {
  if (required) {
    console.error(`[frpc] No pinned frpc build for ${platform}-${arch}.`);
    process.exit(1);
  }
  console.log(`[frpc] Skipping ${platform}-${arch}; no pinned build.`);
  process.exit(0);
}

const destinationDir = NodePath.join(outDir, `${platform}-${arch}`);
const destination = NodePath.join(destinationDir, target.executable);
if (NodeFS.existsSync(destination)) {
  console.log(`[frpc] Using bundled ${platform}-${arch} binary at ${destination}`);
  process.exit(0);
}

if (!target.checksum) {
  if (required) {
    console.error(`[frpc] No pinned checksum for ${platform}-${arch}.`);
    process.exit(1);
  }
  console.log(`[frpc] Skipping ${platform}-${arch}; no pinned checksum.`);
  process.exit(0);
}

const url = `https://github.com/fatedier/frp/releases/download/v${VERSION}/${target.archive}`;
const work = NodePath.join(NodeOS.tmpdir(), `t3-frpc-${process.pid}-${Date.now()}`);
const archivePath = NodePath.join(work, target.archive);
await NodeFSP.mkdir(work, { recursive: true });
try {
  console.log(`[frpc] Downloading ${target.archive}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== target.checksum) {
    throw new Error(`Checksum mismatch for ${target.archive}: ${digest}`);
  }
  await NodeFSP.writeFile(archivePath, bytes);

  const extracted = NodePath.join(work, "extracted");
  await NodeFSP.mkdir(extracted, { recursive: true });
  if (target.archive.endsWith(".zip")) {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone build script has no Effect runtime
    if (NodeOS.platform() === "win32") {
      NodeChildProcess.execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      NodeChildProcess.execFileSync("unzip", ["-q", archivePath, "-d", extracted], {
        stdio: "inherit",
      });
    }
  } else {
    NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", extracted], {
      stdio: "inherit",
    });
  }
  const inner = NodePath.join(
    extracted,
    NodePath.basename(target.archive).replace(/\.(zip|tar\.gz)$/u, ""),
  );
  const source = NodePath.join(inner, target.executable);
  if (!NodeFS.existsSync(source)) {
    throw new Error(`Extracted archive does not contain ${target.executable}`);
  }
  await NodeFSP.mkdir(destinationDir, { recursive: true });
  await NodeFSP.copyFile(source, destination);
  if (platform !== "win") await NodeFSP.chmod(destination, 0o755);
  console.log(`[frpc] Bundled ${destination}`);
} finally {
  await NodeFSP.rm(work, { recursive: true, force: true }).catch(() => undefined);
}
