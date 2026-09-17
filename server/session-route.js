/**
 * Persist the composer route (3A/2A) against a conversation key and, once
 * known, the session file. Saving does not start a chain — it only remembers
 * which roles the user assigned so the UI can restore them.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const KINDS = new Set(["plan", "diagnose", "execute", "review"]);
const BACKENDS = new Set(["pi", "claude", "grok", "codex"]);
const TEMPLATES = new Set(["diagnose", "fix", "plan", "custom"]);

export function routeStoreDir(root = join(homedir(), ".pi-web", "routes")) {
  return root;
}

function fileFor(dir, id) {
  const hash = createHash("sha1").update(id).digest("hex");
  return join(dir, `${hash}.json`);
}

export function normalizeRoute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const template = TEMPLATES.has(raw.template) ? raw.template : null;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const kind = KINDS.has(item.kind) ? item.kind : null;
        const backend = BACKENDS.has(item.backend) ? item.backend : null;
        if (!kind || !backend) return [];
        const id =
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : `step-${index}-${randomUUID().slice(0, 8)}`;
        return [
          {
            id,
            kind,
            backend,
            modelId: typeof item.modelId === "string" ? item.modelId : "",
            modelName: typeof item.modelName === "string" ? item.modelName : "",
            enabled: item.enabled !== false,
          },
        ];
      })
    : [];
  return {
    enabled: Boolean(raw.enabled),
    template,
    steps,
  };
}

async function readRouteFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return normalizeRoute(parsed);
  } catch {
    return null;
  }
}

export async function loadRoute(
  sessionKey,
  sessionFile = "",
  dir = routeStoreDir(),
) {
  if (sessionFile) {
    const fromFile = await readRouteFile(fileFor(dir, `file:${sessionFile}`));
    if (fromFile) return fromFile;
  }
  if (sessionKey) return readRouteFile(fileFor(dir, `key:${sessionKey}`));
  return null;
}

export async function saveRoute(
  sessionKey,
  sessionFile,
  raw,
  dir = routeStoreDir(),
) {
  const route = normalizeRoute(raw);
  if (!route) return { ok: false, error: "Invalid route." };
  await mkdir(dir, { recursive: true });
  const body = `${JSON.stringify(route, null, 2)}\n`;
  const writes = [];
  if (sessionKey) writes.push(writeFile(fileFor(dir, `key:${sessionKey}`), body));
  if (sessionFile)
    writes.push(writeFile(fileFor(dir, `file:${sessionFile}`), body));
  if (writes.length === 0)
    return { ok: false, error: "Missing session key." };
  await Promise.all(writes);
  return { ok: true, route };
}
