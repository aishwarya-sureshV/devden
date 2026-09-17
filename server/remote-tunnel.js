/**
 * `/remote` — one-command phone access to a running pi-web server.
 *
 * Spawns a Cloudflare quick tunnel (`cloudflared tunnel --url`) against the
 * local API port: an outbound-only HTTPS proxy with a public URL and no
 * account, no domain, and nothing to install on the phone. The URL rotates
 * per run and is gated by a token minted here (server/index.js enforces it),
 * so the public URL is worthless to anyone without the QR code.
 *
 * The cloudflared binary is downloaded on first use into ~/.pi-web/bin and
 * cached forever — users never install anything by hand.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const BIN_DIR = join(homedir(), ".pi-web", "bin");
const RELEASES =
  "https://github.com/cloudflare/cloudflared/releases/latest/download";
const URL_TIMEOUT_MS = 30_000;

/**
 * cloudflared's per-platform release assets. The darwin ones are named .tgz
 * but are a gzip of the bare binary (no tar), the linux ones are plain ELF
 * binaries, windows is a bare .exe.
 */
export function assetNameFor(os = platform(), cpu = arch()) {
  if (os === "darwin")
    return cpu === "arm64"
      ? "cloudflared-darwin-arm64.tgz"
      : "cloudflared-darwin-amd64.tgz";
  if (os === "linux")
    return cpu === "arm64"
      ? "cloudflared-linux-arm64"
      : "cloudflared-linux-amd64";
  if (os === "win32") return "cloudflared-windows-amd64.exe";
  throw new Error(`cloudflared has no ${os}/${cpu} build`);
}

/** The only line we need from cloudflared's chatty startup output. */
export function extractTunnelUrl(text) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(text));
  return match ? match[0] : null;
}

async function ensureBinary() {
  const ext = platform() === "win32" ? ".exe" : "";
  const binPath = join(BIN_DIR, `cloudflared${ext}`);
  if (existsSync(binPath)) return binPath;
  mkdirSync(BIN_DIR, { recursive: true });
  const asset = assetNameFor();
  const response = await fetch(`${RELEASES}/${asset}`);
  if (!response.ok)
    throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  const tempPath = `${binPath}.download`;
  writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
  if (asset.endsWith(".tgz")) {
    // The darwin release is a real gzipped tar with one member; extract it
    // with the system tar (bsdtar ships on macOS and Windows 10+).
    await execFileAsync("tar", ["-xzf", tempPath, "-C", BIN_DIR]);
    rmSync(tempPath);
  } else {
    renameSync(tempPath, binPath);
  }
  if (platform() !== "win32") chmodSync(binPath, 0o755);
  return binPath;
}

/** Active tunnel, or null. Shape: { url, token, startedAt, child } */
let tunnel = null;

export function getRemoteTunnel() {
  return tunnel && tunnel.child.exitCode === null ? tunnel : null;
}

/**
 * Starts (or returns the already running) quick tunnel against `port`.
 * Resolves with { url, token } once cloudflared prints its public URL.
 */
export async function startRemoteTunnel(port) {
  const running = getRemoteTunnel();
  if (running) return { url: running.url, token: running.token };

  const bin = await ensureBinary();
  const token = randomBytes(24).toString("base64url");
  const child = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const state = { url: null, token, startedAt: Date.now(), child };
  child.on("exit", () => {
    if (tunnel === state) tunnel = null;
  });
  // cloudflared logs to stderr, but both pipes are watched either way.
  const chunks = [];
  const collect = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (state.url) return; // tunnel is up; further output is diagnostics noise
      chunks.push(chunk);
      const url = extractTunnelUrl(chunks.join(""));
      if (url) {
        state.url = url;
        chunks.length = 0;
      }
    });
  };
  collect(child.stdout);
  collect(child.stderr);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const tail = chunks.join("").split("\n").slice(-12).join("\n");
      child.kill();
      reject(
        new Error(
          `cloudflared started but printed no tunnel URL in ${URL_TIMEOUT_MS / 1000}s.\n${tail}`,
        ),
      );
    }, URL_TIMEOUT_MS);
    const check = setInterval(() => {
      if (state.url) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 100);
    child.on("exit", () => {
      clearTimeout(timer);
      clearInterval(check);
      if (!state.url)
        reject(
          new Error(
            `cloudflared exited before printing a tunnel URL.\n${chunks.join("").slice(-600)}`,
          ),
        );
    });
  });

  tunnel = state;
  return { url: state.url, token: state.token };
}

/** Kills the tunnel and revokes its token. Safe to call when not running. */
export function stopRemoteTunnel() {
  const running = getRemoteTunnel();
  tunnel = null;
  if (running) {
    running.child.kill();
    return { ok: true, url: running.url };
  }
  return { ok: false };
}
