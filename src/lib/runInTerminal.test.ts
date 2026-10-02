import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node-pty";
import {
  clipOutput,
  commandToPtyInput,
  ingestPtyChunk,
  isShellLanguage,
  stripAnsi,
  stripPromptPrefixes,
  tabLabelFor,
} from "./runInTerminal.ts";

describe("isShellLanguage", () => {
  it("accepts common shell fences", () => {
    assert.equal(isShellLanguage("bash"), true);
    assert.equal(isShellLanguage("BASH"), true);
    assert.equal(isShellLanguage("zsh"), true);
    assert.equal(isShellLanguage("console"), true);
  });

  it("rejects non-shell fences and missing tags", () => {
    assert.equal(isShellLanguage("ts"), false);
    assert.equal(isShellLanguage("json"), false);
    assert.equal(isShellLanguage(""), false);
    assert.equal(isShellLanguage(undefined), false);
  });
});

describe("stripPromptPrefixes", () => {
  it("drops copy-paste $ / % / > prompts", () => {
    assert.equal(stripPromptPrefixes("$ npm i\n% grok mcp list"), "npm i\ngrok mcp list");
    assert.equal(stripPromptPrefixes("> echo hi"), "echo hi");
  });

  it("leaves comments and ordinary lines alone", () => {
    assert.equal(stripPromptPrefixes("# keep me\necho hi"), "# keep me\necho hi");
  });
});

describe("commandToPtyInput", () => {
  it("joins lines with CR and appends an exit marker", () => {
    assert.equal(
      commandToPtyInput("grok mcp add x\ngrok mcp doctor x"),
      "grok mcp add x\rgrok mcp doctor x\recho PIWEB_EXIT:$?\r",
    );
  });
  it("keeps interactive login and its completion marker in one shell statement", () => {
    const input = commandToPtyInput("'/a path/cli' login --device-auth", true);
    assert.equal(input.split("\r").length, 2);
    assert.match(input, /^eval '/);
    assert.match(input, /; echo PIWEB_EXIT:\$\?\r$/);
  });
  it("leaves provider input for the user and reports completion through a real PTY", async () => {
    const terminal = spawn("/bin/sh", [], { cols: 120, rows: 24 });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let sent = false;
        const timer = setTimeout(() => reject(new Error("Interactive command timed out")), 5000);
        terminal.onData((chunk) => {
          output += chunk;
          if (!sent && /(?:^|[\r\n])ENTER_CODE\r?\n/.test(output)) {
            sent = true;
            terminal.write("user-code\r");
          }
          const result = ingestPtyChunk("", output);
          if (result.exitCode != null) {
            clearTimeout(timer);
            try { assert.equal(result.exitCode, 0); assert.equal(sent, true); resolve(); }
            catch (error) { reject(error); }
          }
        });
        terminal.write(commandToPtyInput("printf 'ENTER_CODE\\n'; read -r answer; [ \"$answer\" = 'user-code' ]", true));
      });
    } finally { terminal.kill(); }
  });
});

describe("tabLabelFor", () => {
  it("uses the first line, truncated", () => {
    assert.equal(tabLabelFor("ls"), "ls");
    assert.equal(
      tabLabelFor("grok mcp add playwright -- npx -y @playwright/mcp@latest --isolated"),
      "grok mcp add playwright -- …",
    );
  });
});

describe("ingestPtyChunk", () => {
  it("strips ansi and the wrapper echo, then reads the exit marker", () => {
    const first = ingestPtyChunk("", "echo PIWEB_EXIT:$?\r\n\u001b[32mok\u001b[0m\r\n");
    assert.equal(first.exitCode, null);
    assert.equal(first.output.includes("ok"), true);
    const done = ingestPtyChunk(first.output, "PIWEB_EXIT:0\r\n");
    assert.equal(done.exitCode, 0);
    assert.equal(done.output.trim(), "ok");
  });

  it("captures a non-zero exit", () => {
    const done = ingestPtyChunk("boom\n", "PIWEB_EXIT:2\n");
    assert.equal(done.exitCode, 2);
    assert.equal(done.output, "boom");
  });
});

describe("stripAnsi / clipOutput", () => {
  it("drops CSI sequences", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  });

  it("keeps a short transcript and ellipsizes a long one", () => {
    assert.equal(clipOutput("abc", 10), "abc");
    assert.equal(clipOutput("abcdefghij", 4), "…\nghij");
  });
});
