const tools: Record<string, string> = {
  read: "#7ab8ff", grep: "#4fe3c1", edit: "#ffb35c", write: "#b8f36a",
  bash: "#ff7eb6", fetch: "#c79bff", agent: "#ffd84d", explored: "#a9b4d0",
};
// Read's blue and grep's teal are reserved: no hashed tool may land near them.
const hues = ["#ff8f6b", "#5ee0a0", "#f7c948", "#e98bff", "#ff7a9c", "#a9d86a", "#9d9bff", "#ffa94d"];
const families: [RegExp, string][] = [
  [/search|find|grep|glob|rg/i, "grep"], [/read|view|cat|open/i, "read"],
  [/edit|patch|replace|apply/i, "edit"], [/write|create|new/i, "write"],
  [/bash|shell|exec|run|cmd|term/i, "bash"], [/fetch|http|web|url|browse|curl/i, "fetch"],
  [/agent|task|spawn|delegate/i, "agent"],
];
export function toolLook(name: string): { color: string; icon: string } {
  const key = name.toLowerCase();
  if (tools[key]) return { color: tools[key], icon: key };
  const base = key.replace(/^mcp[_·:.\s]+/, "");
  let hash = 0;
  for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { color: hues[hash % hues.length]!, icon: families.find(([pattern]) => pattern.test(base))?.[1] ?? "_unknown" };
}
export const fmtCount = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, "") + "M"
  : n >= 1e4 ? (n / 1e3).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, "") + "k"
  : n.toLocaleString("en-US");
