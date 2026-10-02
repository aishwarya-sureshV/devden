/**
 * Session → reusable skill, human-gated.
 *
 * /skill sends DISTILL_SKILL_PROMPT to the session's own agent — its history
 * IS the input, nothing to attach or re-read — and the agent replies with a
 * fenced ```skilldraft block holding JSON. RichText renders that fence as a
 * SkillDraftCard; staging it drops it into the Skills view's editor for
 * review before save. The review gate is the point: a stale or one-off
 * recipe must never reach ~/.pi/agent/skills unexamined, because pi loads
 * every saved skill into future sessions.
 */

export interface SkillDraftSeed {
  backend?: "pi" | "codex";
  name: string;
  description: string;
  body: string;
}

export const DISTILL_SKILL_PROMPT = [
  "Distill this session into a reusable, parameterized skill — a recipe that can be replayed later with new arguments.",
  "",
  "First decide honestly: was this session a repeatable recipe (a pipeline, a setup, a recurring workflow),",
  "or a one-off — a bug bound to this code state, pure research, exploration? For one-offs, reply in one",
  "short line saying it does not parameterize and do not emit any block. Do not force a skill out of thin work.",
  "",
  "For a recipe-shaped session, reply with a single fenced block tagged skilldraft holding only JSON:",
  '{"name": "short skill name", "description": "one sentence on when to use it",',
  '"body": "the SKILL.md body"}',
  "",
  "body rules — the skill replays later on a repo that has since changed:",
  "- Parameterize session-specific values as $ARGUMENTS (the invocation text) or named placeholders.",
  "- Reference files by path only, never line numbers; prefer naming the symbol over quoting the code.",
  "- Imperative steps, in order, ending with the exact verification commands (typecheck/tests/build).",
  "- No transcript narration, no tool-call log — only the distilled recipe.",
  "",
  "No prose outside the block.",
].join("\n");

/**
 * Parse a skilldraft payload. Returns null for anything malformed, so
 * RichText falls back to rendering the raw fence instead of a broken card.
 */
export function parseSkillDraft(raw: string): SkillDraftSeed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const row = parsed as Partial<SkillDraftSeed> | null;
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  const description =
    typeof row?.description === "string" ? row.description.trim() : "";
  const body = typeof row?.body === "string" ? row.body.trim() : "";
  if (!name || !description || !body) return null;
  return { name, description, body };
}

/** First complete ```skilldraft fence payload, or null while still streaming. */
export function firstSkillDraftPayload(
  text: string | undefined,
): string | null {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})[ \t]*skilldraft[ \t]*$/.exec(
      lines[i] ?? "",
    );
    if (!open) continue;
    const marker = open[2] ?? "```";
    const char = marker[0];
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(lines[j] ?? "");
      if (
        close &&
        (close[2] ?? "")[0] === char &&
        (close[2] ?? "").length >= marker.length
      ) {
        return lines.slice(i + 1, j).join("\n");
      }
    }
    return null;
  }
  return null;
}
