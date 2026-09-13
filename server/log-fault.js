import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Faults go to a file, not just stderr.
 *
 * Whoever started this process owns its output -- a terminal that has since
 * been closed, a task runner, a scratch file nobody will find -- so a fault
 * that only console.errors is a fault nobody can read afterwards. That is the
 * whole reason the first stall was undiagnosable. One append-only line each,
 * beside the project, gitignored by *.log.
 */
export function logFault(kind, ...detail) {
  console.error(`[pi-web] ${kind}`, ...detail);
  try {
    const text = detail
      .map((part) =>
        part instanceof Error ? (part.stack ?? part.message) : String(part),
      )
      .join(" ");
    appendFileSync(
      join(ROOT, "server-faults.log"),
      `${new Date().toISOString()} ${kind} ${text}\n`,
    );
  } catch {
    /* the fault matters more than the record of it */
  }
}
