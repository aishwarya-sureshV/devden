// Loads .env from the repo root. Imported FIRST by server/index.js so every
// start path (npm run dev, preview, deploy restart) has env vars before any
// other module reads process.env. Existing env wins; no dotenv dependency.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Agents installed from Connect belong to this user, including on cloud VMs.
const agentBin = join(homedir(), ".local", "bin");
if (!(process.env.PATH || "").split(delimiter).includes(agentBin))
  process.env.PATH = `${process.env.PATH || ""}${delimiter}${agentBin}`;

try {
  for (const line of readFileSync(
    new URL("../.env", import.meta.url),
    "utf8",
  ).split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch {
  /* no .env — fine */
}
