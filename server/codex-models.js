import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { latestVersion } from "./harness-update.js";

// A custom CLI may report 0.0.0, which makes the service return its legacy
// catalog. Discover against the current catalog schema without replacing
// the user's CLI or changing its inference configuration.
export async function readCodexModels() {
  const auth = JSON.parse(await readFile(
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    "utf8",
  ));
  const token = auth.tokens?.access_token;
  if (!token) throw new Error("Codex ChatGPT credentials unavailable");
  const version = await latestVersion("@openai/codex");
  if (!version) throw new Error("Codex catalog version unavailable");
  const response = await fetch(
    `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(auth.tokens.account_id ? { "ChatGPT-Account-Id": auth.tokens.account_id } : {}),
        originator: "codex_cli_rs",
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error(`Codex models returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.models) || !payload.models.length)
    throw new Error("Codex models returned an empty catalog");
  return payload.models.filter((model) => typeof model.slug === "string").map((model) => ({
    id: model.slug,
    displayName: model.display_name ?? model.slug,
    hidden: model.visibility !== "list" || model.supported_in_api === false,
    supportedReasoningEfforts: (model.supported_reasoning_levels ?? []).map((option) => ({
      reasoningEffort: option.effort,
    })),
    defaultReasoningEffort: model.default_reasoning_level,
    contextWindow: model.context_window,
  }));
}
