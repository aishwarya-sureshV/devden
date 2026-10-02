import test from "node:test";
import assert from "node:assert/strict";
import { loginPiSubscription } from "./pi-login.js";

test("Pi setup offers subscription providers and invokes OAuth only", async () => {
  const messages = [];
  const answers = ["0", "api-key", "2"];
  let selected;
  await loginPiSubscription({
    getProviders: () => [
      { id: "api", auth: { apiKey: { name: "API key" } } },
      { id: "non-subscription", auth: { oauth: { name: "Other OAuth" } } },
      { id: "claude", auth: { oauth: { name: "Claude subscription", isSubscription: true } } },
      { id: "codex", auth: { oauth: { name: "ChatGPT subscription", isSubscription: true } } },
    ],
    login: async (id, type, interaction) => {
      selected = { id, type };
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/device" });
      return { access: "must-not-be-printed" };
    },
  }, { prompt: async () => answers.shift(), notify: (message) => messages.push(message) });
  assert.deepEqual(selected, { id: "codex", type: "oauth" });
  assert.match(messages.join("\n"), /ChatGPT subscription/);
  assert.doesNotMatch(messages.join("\n"), /API key|Other OAuth|must-not-be-printed/);
  await assert.rejects(loginPiSubscription({ getProviders: () => [] }, {}), /no subscription/);
});
