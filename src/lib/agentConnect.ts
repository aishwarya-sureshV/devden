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

/** A pairing code the CLI prints during sign-in, when there is one. */
export function loginCode(output: string): string | null {
  // Codes ride either in the sign-in URL's query or alone on a line.
  const inUrl = output.match(/[?&](?:code|user_code|verification_code)=([A-Z0-9-]{4,20})/i);
  if (inUrl) return inUrl[1].toUpperCase();
  // ponytail: loose standalone pattern (line/space/colon context); tighten if a CLI ever prints lookalikes.
  const alone = output.match(/(?:^|[:\s])([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/m);
  return alone ? alone[1] : null;
}
