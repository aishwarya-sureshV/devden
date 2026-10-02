import assert from "node:assert/strict";
import test from "node:test";
import { api, apiOrigin } from "./api.ts";

test("API URLs stay on the phone tunnel and honor only local overrides", (t) => {
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  const originFor = (url: string) => {
    Object.defineProperty(globalThis, "window", {
      configurable: true, value: { location: new URL(url) },
    });
    return apiOrigin();
  };
  assert.equal(originFor("https://devden-phone.trycloudflare.com/"), "");
  assert.equal(originFor("http://[::1]:4319/"), "");
  assert.equal(originFor("http://localhost:5319/"), "");
  assert.equal(originFor("https://hosted.example/"), "http://127.0.0.1:4319");
  assert.equal(originFor("https://hosted.example/?api=http://localhost:4444"), "http://localhost:4444");
  assert.equal(originFor("https://devden-phone.trycloudflare.com/?api=https://untrusted.example"), "");
});


test("history reads share in-flight work and refresh after completion or failure", async (t) => {
  let calls = 0;
  let release: (value: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", () => {
    calls += 1;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const first = api.sessionMessages("/test/session.jsonl");
  const second = api.sessionMessages("/test/session.jsonl");
  assert.equal(first, second);
  assert.equal(calls, 1);
  release(new Response(JSON.stringify({ ok: true, messages: [] })));
  await first;
  const fresh = api.sessionMessages("/test/session.jsonl");
  assert.equal(calls, 2);
  release(new Response("unreadable"));
  await assert.rejects(fresh);
  const retry = api.sessionMessages("/test/session.jsonl");
  assert.equal(calls, 3);
  release(new Response(JSON.stringify({ ok: true, messages: [] })));
  await retry;
});
