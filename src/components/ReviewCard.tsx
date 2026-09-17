import {
  backendLabel,
  backendMark,
  type AgentBackend,
} from "../lib/api";
import { useStore, useTimeline } from "../lib/store";
import {
  mergeReviews,
  parseIntegrityReview,
  parseTaskReview,
  queueFixesPrompt,
  reviewVerdictLabel,
  type IntegrityFinding,
  type IntegritySeverity,
  type MergedReview,
} from "../lib/turnReview";
import { BackendLogo } from "./icons";

export function ReviewCard({
  backend,
  integrityKey,
  taskKey,
  onQueue,
  onOpen,
  onDismiss,
}: {
  backend: AgentBackend;
  integrityKey: string;
  taskKey: string;
  onQueue: (text: string) => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { tabs } = useStore();
  const integrityTab = tabs.find((item) => item.key === integrityKey);
  const taskTab = tabs.find((item) => item.key === taskKey);
  const integrityTl = useTimeline(integrityTab?.timeline);
  const taskTl = useTimeline(taskTab?.timeline);
  const integrityStreaming = Boolean(
    integrityTl?.status === "working" || integrityTl?.state?.isStreaming,
  );
  const taskStreaming = Boolean(
    taskTl?.status === "working" || taskTl?.state?.isStreaming,
  );
  const streaming = integrityStreaming || taskStreaming;
  const integrityText = assistantText(integrityTl);
  const taskText = assistantText(taskTl);
  const error = noticeError(integrityTl) || noticeError(taskTl);
  const merged =
    !streaming && (integrityText || taskText)
      ? mergeReviews(
          integrityText
            ? parseIntegrityReview(integrityText)
            : { verdict: "pass", findings: [], needsVerification: [] },
          taskText
            ? parseTaskReview(taskText)
            : {
                requirements: [],
                approachConcern: "",
                unrequestedChanges: [],
              },
        )
      : null;
  const mark = backendMark(backend);
  const queued = merged ? queueFixesPrompt(merged) : "";
  const counts = countFindings(merged);

  return (
    <article className="review-card">
      <header className="review-card__head">
        <span className="review-card__tile" style={{ color: mark.color }}>
          <BackendLogo backend={backend} size={16} />
        </span>
        <strong>{backendLabel(backend).toLowerCase()}</strong>
        <span className="review-card__meta">
          {[
            "integrity + task",
            streaming
              ? runningLabel(integrityStreaming, taskStreaming)
              : "this turn",
            "not an approval",
          ].join(" · ")}
        </span>
        {merged ? (
          <span
            className={`review-card__verdict${
              merged.sendBack
                ? " is-changes"
                : merged.verdict === "issues_found"
                  ? " is-issues"
                  : ""
            }`}
          >
            {reviewVerdictLabel(merged.verdict)}
          </span>
        ) : null}
        {counts ? (
          <span className="review-card__counts">
            {counts.blocker} blocking · {counts.major} major · {counts.minor}{" "}
            minor
          </span>
        ) : null}
      </header>
      <div className="review-card__body">
        {error && !integrityText && !taskText ? (
          <p className="review-card__empty">{error}</p>
        ) : merged ? (
          <MergedBody merged={merged} />
        ) : (
          <p className="review-card__empty">
            {runningLabel(integrityStreaming, taskStreaming)}
          </p>
        )}
      </div>
      <footer className="review-card__foot">
        <button
          type="button"
          className="review-card__primary"
          disabled={streaming || !queued}
          onClick={() => onQueue(queued)}
        >
          {merged?.sendBack ? "Send back to author" : "Queue notes"}
        </button>
        <button type="button" onClick={onOpen}>
          Open integrity
        </button>
        <button type="button" className="review-card__dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </footer>
    </article>
  );
}

function MergedBody({ merged }: { merged: MergedReview }) {
  const missing = merged.requirements.filter(
    (item) => item.status !== "satisfied",
  );
  const groups: IntegritySeverity[] = ["blocker", "major", "minor"];
  if (
    merged.verdict === "pass" &&
    !merged.findings.length &&
    !missing.length &&
    !merged.needsVerification.length
  ) {
    return (
      <p className="review-card__empty">
        No blockers, and the asked work is in the diff. This is information,
        not an approval.
      </p>
    );
  }
  return (
    <>
      {groups.map((severity) => {
        const items = merged.findings.filter(
          (finding) => finding.severity === severity,
        );
        if (!items.length) return null;
        return (
          <section key={severity} className="review-card__group">
            <h4 className={`review-card__group-title is-${severity}`}>
              {severity}
            </h4>
            <ul className="review-card__findings">
              {items.map((finding, index) => (
                <FindingRow
                  key={`${finding.file}:${finding.startLine}:${index}`}
                  finding={finding}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {missing.length > 0 && (
        <section className="review-card__group">
          <h4 className="review-card__group-title is-major">requirements</h4>
          <ul className="review-card__findings">
            {missing.map((item, index) => (
              <li
                key={`req:${index}`}
                className={`review-card__finding is-${item.status === "not_satisfied" ? "blocker" : "major"}`}
              >
                <span className="review-card__dot" aria-hidden />
                <em>{item.status.replaceAll("_", " ")}</em>
                <span>
                  {item.item}
                  {item.note ? ` — ${item.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {merged.approachConcern ? (
        <p className="review-card__empty">{merged.approachConcern}</p>
      ) : null}
      {merged.needsVerification.length > 0 ? (
        <p className="review-card__empty">
          Needs verification: {merged.needsVerification.join(" · ")}
        </p>
      ) : null}
    </>
  );
}

function FindingRow({ finding }: { finding: IntegrityFinding }) {
  const where = finding.file
    ? `${finding.file}${finding.startLine ? `:${finding.startLine}` : ""}`
    : "";
  return (
    <li className={`review-card__finding is-${finding.severity}`}>
      <span className="review-card__dot" aria-hidden />
      {where ? <code>{where}</code> : null}
      <em>{finding.severity}</em>
      <span>
        {finding.trigger}
        {finding.consequence ? ` → ${finding.consequence}` : ""}
      </span>
    </li>
  );
}

function countFindings(merged: MergedReview | null) {
  if (!merged || !merged.findings.length) return null;
  return {
    blocker: merged.findings.filter((item) => item.severity === "blocker").length,
    major: merged.findings.filter((item) => item.severity === "major").length,
    minor: merged.findings.filter((item) => item.severity === "minor").length,
  };
}

function assistantText(
  timeline: { items: { kind: string; text?: string }[] } | undefined,
): string {
  if (!timeline) return "";
  return timeline.items
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text ?? "")
    .join("\n\n")
    .trim();
}

function noticeError(
  timeline:
    | { items: { kind: string; tone?: string; text?: string }[] }
    | undefined,
): string {
  const item = timeline?.items.find(
    (entry) => entry.kind === "notice" && entry.tone === "error",
  );
  return item?.text ?? "";
}

function runningLabel(integrity: boolean, task: boolean): string {
  if (integrity && task) return "integrity and task running";
  if (integrity) return "integrity running";
  if (task) return "task running";
  return "Waiting for the reviewer.";
}
