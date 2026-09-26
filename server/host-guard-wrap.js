#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  blockedCommandReason,
  commandLineFor,
  defaultGuardContext,
  realBinary,
} from "./host-guard.js";

const tool = String(process.argv[2] ?? "");
const args = process.argv.slice(3);
const reason = blockedCommandReason(
  commandLineFor(tool, args),
  defaultGuardContext(process.env),
);
if (reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

const real = realBinary(tool, process.env.DEVDEN_HOST_GUARD_PATH);
const child = spawn(real, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: process.env.DEVDEN_HOST_GUARD_PATH || process.env.PATH,
  },
});
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
