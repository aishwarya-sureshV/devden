/** Shell fences the conversation may run in the docked terminal. */
const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "terminal",
  "fish",
]);

export const EXIT_MARKER = "PIWEB_EXIT:";

export function isShellLanguage(language?: string): boolean {
  if (!language) return false;
  return SHELL_LANGUAGES.has(language.trim().toLowerCase());
}

/** Drop `$ ` / `% ` / `> ` prompt prefixes agents often put on copy-paste blocks. */
export function stripPromptPrefixes(command: string): string {
  return command
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*[\$%>]\s+/, ""))
    .join("\n");
}

/** Paste into a login PTY: each line as Enter, then an exit-code marker. */
export function commandToPtyInput(command: string): string {
  const lines = stripPromptPrefixes(command)
    .replace(/\s+$/g, "")
    .split("\n");
  const body = lines.length === 1 && lines[0] === "" ? [] : lines;
  return [...body, `echo ${EXIT_MARKER}$?`].join("\r") + "\r";
}

export function tabLabelFor(command: string): string {
  const first = stripPromptPrefixes(command)
    .trim()
    .split("\n")[0]
    ?.replace(/\s+/g, " ") ?? "";
  if (!first) return "Run";
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CHARSET = /\u001b[()][AB012]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_CHARSET, "")
    .replace(/\r/g, "")
    .replace(/\u0008/g, "");
}

function stripEchoLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*echo PIWEB_EXIT:/.test(line))
    .join("\n");
}

export function ingestPtyChunk(
  prevOutput: string,
  chunk: string,
): { output: string; exitCode: number | null } {
  const combined = prevOutput + stripAnsi(chunk);
  const match = /PIWEB_EXIT:(-?\d+)/.exec(combined);
  if (!match || match.index == null) {
    return { output: stripEchoLine(combined), exitCode: null };
  }
  return {
    output: stripEchoLine(combined.slice(0, match.index)).replace(/\s+$/g, ""),
    exitCode: Number(match[1]),
  };
}

export function clipOutput(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `…\n${text.slice(text.length - max)}`;
}
