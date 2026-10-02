/**
 * Persist the composer route (3A/2A) against a conversation key and, once
 * known, the session file. Saving does not start a chain — it only remembers
 * which roles the user assigned so the UI can restore them.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { devdenHome, docGet, docSet } from "./db.js";

const KINDS = new Set(["plan", "diagnose", "execute", "review"]);
const BACKENDS = new Set(["pi", "claude", "grok", "codex"]);
const TEMPLATES = new Set(["diagnose", "fix", "plan", "custom"]);

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

/** Pre-SQLite installs kept routes in routes/<sha1>.json; adopt on read. */
async function readLegacy(home, id) {
  const hash = createHash("sha1").update(id).digest("hex");
  try {
    const route = normalizeRoute(
      JSON.parse(await readFile(join(home, "routes", `${hash}.json`), "utf8")),
    );
    if (route) docSet("routes", id, route, home);
    return route;
  } catch {
    return null;
  }
}

async function readRoute(home, id) {
  const stored = docGet("routes", id, home);
  if (stored) return normalizeRoute(stored);
  return readLegacy(home, id);
}

/** `home` is the devden data dir; tests point it at a temp folder. */
export async function loadRoute(sessionKey, sessionFile = "", home = devdenHome()) {
  if (sessionFile) {
    const fromFile = await readRoute(home, `file:${sessionFile}`);
    if (fromFile) return fromFile;
  }
  if (sessionKey) return readRoute(home, `key:${sessionKey}`);
  return null;
}

export async function saveRoute(sessionKey, sessionFile, raw, home = devdenHome()) {
  const route = normalizeRoute(raw);
  if (!route) return { ok: false, error: "Invalid route." };
  if (!sessionKey && !sessionFile)
    return { ok: false, error: "Missing session key." };
  if (sessionKey) docSet("routes", `key:${sessionKey}`, route, home);
  if (sessionFile) docSet("routes", `file:${sessionFile}`, route, home);
  return { ok: true, route };
}
