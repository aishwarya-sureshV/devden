/** Shared HTTP/WebSocket access checks. Public tunnel origins must match exactly. */
export function isAllowedOrigin(origin, uiOrigin, tunnelOrigin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      origin === uiOrigin ||
      origin === tunnelOrigin
    );
  } catch {
    return false;
  }
}

export function isLoopbackRequest(req) {
  // cloudflared connects over loopback too, but supplies these edge headers.
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"])
    return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket?.remoteAddress,
  );
}

// DNS rebinding: evil.example re-resolved to 127.0.0.1 arrives over loopback
// with no Origin on same-origin GETs, but its Host header still names the
// attacker. Token-free access is only for a loopback socket AND a loopback Host.
export function isLoopbackHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(host.replace(/:\d+$/, ""));
}

export function requestHasAccess(req, url, staticToken, tunnelToken, consumeTicket) {
  const tokens = [staticToken, tunnelToken].filter(Boolean);
  if (!staticToken && isLoopbackRequest(req) && isLoopbackHost(req)) return true;
  const header = String(req.headers.authorization || "");
  const cookies = String(req.headers.cookie || "").split(";");
  for (const token of tokens) {
    if (header === `Bearer ${token}`) return true;
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const password = decoded.includes(":")
        ? decoded.slice(decoded.indexOf(":") + 1)
        : decoded;
      if (password === token) return true;
    }
    if (cookies.some((part) => part.trim() === `devden-token=${token}`))
      return true;
  }
  // Raw static tokens never go in URLs. Transport tickets are single-use.
  if (consumeTicket(url.searchParams.get("ticket"))) return true;
  return Boolean(tunnelToken && url.searchParams.get("token") === tunnelToken);
}
