import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOrigin, requestHasAccess } from "./request-access.js";

test("HTTP and WebSocket access require configured tokens, including on loopback", () => {
  const local = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const remote = { ...local, headers: { "cf-connecting-ip": "203.0.113.1" } };
  const url = new URL("http://localhost/api/auth/status");
  const noTicket = () => false;
  const access = (req, token = "", tunnel = "") =>
    requestHasAccess(req, url, token, tunnel, noTicket);
  assert.equal(access(local), true);
  assert.equal(access(local, "secret"), false);
  assert.equal(access(local, "", "phone"), true);
  assert.equal(access(remote, "", "phone"), false);
  assert.equal(access({ ...local, headers: { authorization: "Bearer secret" } }, "secret"), true);
  assert.equal(access({ ...remote, headers: { ...remote.headers, cookie: "devden-token=phone" } }, "", "phone"), true);
  assert.equal(access({ ...local, headers: { authorization: `Basic ${Buffer.from(":secret").toString("base64")}` } }, "secret"), true);
  assert.equal(requestHasAccess(local, new URL("http://localhost/api/events?token=secret"), "secret", "", noTicket), false);
  const tickets = new Set(["once"]);
  const ticketUrl = new URL("http://localhost/api/events?ticket=once");
  const consume = (ticket) => tickets.delete(ticket);
  assert.equal(requestHasAccess(local, ticketUrl, "secret", "", consume), true);
  assert.equal(requestHasAccess(local, ticketUrl, "secret", "", consume), false);
});

test("only local, explicitly hosted, and the active tunnel origin are trusted", () => {
  const allowed = (origin) => isAllowedOrigin(origin, "https://ui.example", "https://phone.trycloudflare.com");
  assert.equal(allowed("http://localhost:5319"), true);
  assert.equal(allowed("http://[::1]:4319"), true);
  assert.equal(allowed("https://ui.example"), true);
  assert.equal(allowed("https://phone.trycloudflare.com"), true);
  assert.equal(allowed("https://other.trycloudflare.com"), false);
  assert.equal(allowed("https://untrusted.example"), false);
  assert.equal(allowed("https://localhost.untrusted.example"), false);
  assert.equal(allowed("null"), false);
});
