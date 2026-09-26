/**
 * First-run setup. Done means the welcome / agents / start screens stay
 * closed. The choice of default agent and workspace is remembered with it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function devdenHome() {
  if (process.env.DEVDEN_HOME) return process.env.DEVDEN_HOME;
  const next = join(homedir(), ".devden");
  const previous = join(homedir(), ".pi-web");
  if (existsSync(next) || !existsSync(previous)) return next;
  return previous;
}

function file() {
  return join(devdenHome(), "onboarding.json");
}

export function readSetup() {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    return {
      done: Boolean(parsed?.done),
      defaultBackend:
        typeof parsed?.defaultBackend === "string"
          ? parsed.defaultBackend
          : null,
      workspace:
        typeof parsed?.workspace === "string" ? parsed.workspace : null,
    };
  } catch {
    // No onboarding.json yet: installs that already have history predate
    // onboarding and should go straight to the workbench.
    const existing = ["transcripts", "routes", "display-history"].some(
      (dir) => existsSync(join(devdenHome(), dir)),
    );
    return { done: existing, defaultBackend: null, workspace: null };
  }
}

export function writeSetup(input) {
  const next = {
    done: Boolean(input?.done),
    defaultBackend:
      typeof input?.defaultBackend === "string" && input.defaultBackend
        ? input.defaultBackend.slice(0, 40)
        : null,
    workspace:
      typeof input?.workspace === "string" && input.workspace
        ? input.workspace.slice(0, 1000)
        : null,
  };
  const home = devdenHome();
  mkdirSync(home, { recursive: true });
  const path = file();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  return next;
}
