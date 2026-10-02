import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the npm launcher resolves absolute and relative symlinks before loading helpers", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "devden-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launcher = fileURLToPath(new URL("../bin/devden", import.meta.url));
  symlinkSync(launcher, join(dir, "absolute"));
  symlinkSync("absolute", join(dir, "relative"));
  for (const command of [launcher, join(dir, "absolute"), join(dir, "relative")])
    assert.match(execFileSync("bash", [command, "--help"], { encoding: "utf8" }), /Usage: devden/);
});

test("stopping the launcher stops its supervisor, while a standalone server stops directly", () => {
  const helper = fileURLToPath(new URL("../bin/lib/devden-launcher.sh", import.meta.url));
  for (const [parent, target] of [
    ["node scripts/supervise.mjs", "42"],
    ["node /tmp/devden/scripts/supervise.mjs", "42"],
    ["/bin/zsh", "99"],
  ]) {
    const output = execFileSync("bash", ["-c", `
      source "$1"
      ps() {
        if [[ "$4" == "ppid=" ]]; then echo ' 42'; else echo "$TEST_PARENT"; fi
      }
      kill() { echo "$*"; }
      terminate_server 99
    `, "test", helper], {
      encoding: "utf8", env: { ...process.env, TEST_PARENT: parent },
    });
    assert.equal(output.trim(), `-TERM ${target}`);
  }
});
