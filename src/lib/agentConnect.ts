/** Only turn provider-owned HTTPS URLs into sign-in links. */
export function loginLink(output: string): string | null {
  const hosts = new Set([
    "auth.openai.com", "chatgpt.com", "claude.ai", "platform.claude.com",
    "console.anthropic.com", "auth.anthropic.com", "auth.x.ai", "accounts.x.ai",
    "grok.com", "github.com", "accounts.google.com", "auth.kimi.com", "auth.meta.com",
  ]);
  for (const candidate of output.match(/https:\/\/[^\s<>"']+/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      if (!url.username && !url.password && (!url.port || url.port === "443") && hosts.has(url.hostname))
        return url.href;
    } catch { /* incomplete URL while the terminal is streaming */ }
  }
  return null;
}
