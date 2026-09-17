import { useState } from "react";
import { useStore } from "../lib/store";
import type { SkillDraftSeed } from "../lib/skilldraft";

/**
 * Renders the agent's ```skilldraft fence. The card is the human gate:
 * "Stage" only copies the draft into the store slot — the Skills view opens
 * it in its editor, and nothing reaches ~/.pi/agent/skills until the user
 * saves there. Styling rides the ask-card classes; only the body preview
 * and button row are specific.
 */
export function SkillDraftCard({ draft }: { draft: SkillDraftSeed }) {
  const { setSkillDraft } = useStore();
  const [staged, setStaged] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <div className="ask-card skill-draft-card">
      <div className="ask-card__top">
        <span className="ask-card__step skill-draft-card__badge">skill</span>
        <p className="ask-card__prompt">
          <strong>{draft.name}</strong> — {draft.description}
        </p>
      </div>
      {!open && draft.body && (
        <button
          type="button"
          className="skill-draft-card__preview-toggle"
          onClick={() => setOpen(true)}
        >
          Preview body
        </button>
      )}
      {open && <pre className="skill-draft-card__body">{draft.body}</pre>}
      <div className="ask-card__foot">
        <button
          type="button"
          className="ask-card__next"
          disabled={staged}
          onClick={() => {
            setSkillDraft(draft);
            setStaged(true);
          }}
        >
          {staged
            ? "Staged — open Skills to review and save"
            : "Stage for review in Skills"}
        </button>
      </div>
    </div>
  );
}
