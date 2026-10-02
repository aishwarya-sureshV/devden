/**
 * First-run setup. Done means the welcome / agents / start screens stay
 * closed. The choice of default agent and workspace is remembered with it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devdenHome, docGet, docSet } from "./db.js";

export { devdenHome };

function normalize(raw) {
  return {
    done: Boolean(raw?.done),
    defaultBackend:
      typeof raw?.defaultBackend === "string" && raw.defaultBackend
        ? raw.defaultBackend.slice(0, 40)
        : null,
    workspace:
      typeof raw?.workspace === "string" && raw.workspace
        ? raw.workspace.slice(0, 1000)
        : null,
  };
}

export function readSetup() {
  const stored = docGet("setup", "onboarding");
  if (stored) return normalize(stored);
  // Pre-SQLite installs kept this in onboarding.json; adopt it once.
  try {
    const legacy = normalize(
      JSON.parse(readFileSync(join(devdenHome(), "onboarding.json"), "utf8")),
    );
    docSet("setup", "onboarding", legacy);
    return legacy;
  } catch {
    // Nothing saved yet: installs that already have history predate
    // onboarding and should go straight to the workbench.
    const existing = ["transcripts", "routes", "display-history"].some(
      (dir) => existsSync(join(devdenHome(), dir)),
    );
    return { done: existing, defaultBackend: null, workspace: null };
  }
}

export function writeSetup(input) {
  const next = normalize(input);
  docSet("setup", "onboarding", next);
  return next;
}
