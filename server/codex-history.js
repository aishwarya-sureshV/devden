import { stripClarifyPrefix } from "./co-partner-prompt.js";

export function codexUsageFrom(tokens, baseline = {}) {
  if (!tokens) return undefined;
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const count = (camel, snake) => Math.max(0, number(tokens[camel] ?? tokens[snake]) - number(baseline[camel] ?? baseline[snake]));
  const cached = count("cachedInputTokens", "cached_input_tokens");
  return {
    input: Math.max(0, count("inputTokens", "input_tokens") - cached),
    output: count("outputTokens", "output_tokens"), cacheRead: cached,
    cacheWrite: count("cacheWriteInputTokens", "cache_write_input_tokens"),
    totalTokens: count("totalTokens", "total_tokens"),
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).map((part) => part.text ?? "").join("");
}

export function codexUserContent(content) {
  return (content ?? []).flatMap((part) => {
    if (["text", "input_text"].includes(part.type) || (part.type === undefined && typeof part.text === "string"))
      return [{ type: "text", text: stripClarifyPrefix(part.text ?? "") }];
    const url = part.url ?? part.imageUrl ?? part.image_url;
    if (["image", "input_image"].includes(part.type) && typeof url === "string") {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return match ? [{ type: "image", mimeType: match[1], data: match[2] }] : [{ type: "image", url }];
    }
    if (part.type === "localImage") return [{ type: "image", path: part.path }];
    return [];
  });
}

/** Read model conversation items, plus the unencrypted usage and turn metadata. */
export function readCodexLog(contents) {
  const messages = [], turns = [], models = new Set(), toolNames = new Map();
  let assistant, lastAssistant, lastModel, lastEffort, tokenUsage, turn, baseline = {};
  const pushAssistant = () => {
    if (assistant?.content.length) { messages.push(assistant); lastAssistant = assistant; }
    assistant = undefined;
  };
  const openAssistant = (timestamp) => {
    if (!assistant) assistant = { role: "assistant", content: [], timestamp, api: "codex", provider: "codex", model: lastModel };
    return assistant;
  };
  for (const line of String(contents || "").split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const item = entry.payload;
    if (!item) continue;
    const timestamp = Date.parse(entry.timestamp ?? "") || Date.now();
    if (entry.type === "turn_context") {
      lastModel = item.model ?? lastModel;
      lastEffort = item.effort ?? lastEffort;
      if (lastModel) models.add(lastModel);
      if (turn && (!item.turn_id || turn.id === item.turn_id)) Object.assign(turn, { model: lastModel, thinkingLevel: lastEffort });
      continue;
    }
    if (entry.type === "event_msg") {
      if (item.type === "task_started" || item.type === "turn_started") {
        pushAssistant();
        baseline = tokenUsage?.total ?? {};
        turn = { id: item.turn_id, timestamp, model: lastModel, thinkingLevel: lastEffort };
        turns.push(turn);
        lastAssistant = undefined;
      } else if (item.type === "token_count" && item.info) {
        const info = item.info;
        tokenUsage = { total: info.total_token_usage, last: info.last_token_usage, modelContextWindow: info.model_context_window };
        const usage = codexUsageFrom(tokenUsage.total, baseline);
        if (turn) turn.usage = usage;
        // The total belongs to the turn, rather than every intermediate message.
        const target = assistant ?? lastAssistant;
        if (target) {
          if (turn?.usageMessage && turn.usageMessage !== target) delete turn.usageMessage.usage;
          target.usage = usage;
          if (turn) turn.usageMessage = target;
        }
      } else if ((item.type === "task_complete" || item.type === "turn_completed" || item.type === "turn_aborted") && turn) {
        const durationMs = timestamp - turn.timestamp;
        if (turn.usage && durationMs > 0) Object.assign(turn.usage, { durationMs, durationKind: "turn" });
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (item.type === "message") {
      const text = textOf(item.content);
      if (item.role === "assistant") {
        if (text.trim()) openAssistant(timestamp).content.push({ type: "text", text: text.trim() });
      } else if (item.role === "user") {
        // Restrict stripping to Codex's known harness blocks; XML can be a real prompt.
        if (/^\s*<(recommended_plugins|environment_context|permissions instructions|skills_instructions|app-context|collaboration_mode)>/i.test(text)) continue;
        const content = codexUserContent(item.content).map((part) => part.type === "text" ? { ...part, text: part.text.trim() } : part);
        if (!content.some((part) => part.type !== "text" || part.text)) continue;
        pushAssistant();
        messages.push({ role: "user", content, timestamp });
      }
    } else if (item.type === "reasoning") {
      const text = textOf(item.summary);
      if (text) openAssistant(timestamp).content.push({ type: "thinking", thinking: text });
    } else if (item.type === "custom_tool_call" || item.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "");
      const name = item.name === "spawn_agent" ? "spawn_subagent" : String(item.name ?? "tool");
      toolNames.set(id, name);
      let args = item.arguments ?? item.input ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      openAssistant(timestamp).content.push({ type: "toolCall", id, name, arguments: args });
    } else if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
      const id = String(item.call_id ?? "");
      pushAssistant();
      messages.push({ role: "toolResult", toolCallId: id, toolName: toolNames.get(id) ?? "tool", content: [{ type: "text", text: textOf(item.output) }], timestamp });
    }
  }
  pushAssistant();
  return { messages, turns, tokenUsage, lastModel, lastEffort, models: [...models], messageCount: messages.filter((message) => message.role !== "toolResult").length };
}
