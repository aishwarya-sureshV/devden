import assert from "node:assert/strict";
import { test } from "node:test";

import { createTerminalTabs } from "./terminal-tabs.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("run streams output, read returns it and then the exit code", async () => {
  const events = [];
  const tabs = createTerminalTabs({ onEvent: (e) => events.push(e) });
  const { tabId } = tabs.run({
    sessionKey: "s1",
    command: "echo hello-tabs; sleep 0.05",
    cwd: process.cwd(),
  });
  // waitMs gates on *new* output, so this resolves as soon as the echo lands.
  const first = await tabs.read({ sessionKey: "s1", tabId, waitMs: 5_000 });
  assert.equal(first.ok, true);
  assert.match(first.text, /hello-tabs/);
  // Second read with no new output: falls back to the recent-lines tail,
  // like Claude Code's read_terminal returning current tab contents.
  await wait(300);
  const second = await tabs.read({ sessionKey: "s1", tabId });
  assert.equal(second.status, "exited");
  assert.equal(second.exitCode, 0);
  assert.match(second.text, /hello-tabs/);
  assert.ok(events.some((e) => e.type === "terminal_opened"));
  assert.ok(events.some((e) => e.type === "terminal_exit"));
});

test("read with waitMs returns empty while the command is still silent", async () => {
  const tabs = createTerminalTabs({ onEvent: () => {} });
  const { tabId } = tabs.run({
    sessionKey: "s1",
    command: "sleep 0.4; echo late",
    cwd: process.cwd(),
  });
  const started = Date.now();
  const first = await tabs.read({ sessionKey: "s1", tabId, waitMs: 50 });
  assert.equal(first.text, "");
  assert.equal(first.status, "running");
  assert.ok(Date.now() - started < 400);
  const late = await tabs.read({ sessionKey: "s1", tabId, waitMs: 5_000 });
  assert.match(late.text, /late/);
  tabs.stop({ sessionKey: "s1", tabId });
});

test("stop kills a long-running tab", async () => {
  const tabs = createTerminalTabs({ onEvent: () => {} });
  const { tabId } = tabs.run({
    sessionKey: "s1",
    command: "sleep 30",
    cwd: process.cwd(),
  });
  assert.equal(tabs.stop({ sessionKey: "s1", tabId }).ok, true);
  const done = await tabs.read({ sessionKey: "s1", tabId, waitMs: 5_000 });
  assert.equal(done.status, "exited");
});

test("tabs are scoped to their session key", async () => {
  const tabs = createTerminalTabs({ onEvent: () => {} });
  const { tabId } = tabs.run({
    sessionKey: "s1",
    command: "echo x",
    cwd: process.cwd(),
  });
  const cross = await tabs.read({ sessionKey: "s2", tabId, waitMs: 100 });
  assert.equal(cross.ok, false);
  assert.equal(tabs.stop({ sessionKey: "s2", tabId }).ok, false);
});
