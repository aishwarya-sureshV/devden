import type { ToolFileView } from "../lib/toolCards";
import { syntaxLang, type SyntaxLang } from "../lib/syntaxPaint";
import { DiffView } from "./DiffView";
import { BackendLogo } from "./icons";
import { SynText } from "./SynText";

export type ReviewTab = {
  id: string;
  sessionKey: string;
  backend: string;
  sessionTitle: string;
  view: ToolFileView;
};

export type DiffLayout = "unified" | "split";

export function reviewTabId(sessionKey: string, title: string): string {
  return `${sessionKey}\n${title}`;
}

function fileName(path: string): { dir: string; file: string } {
  const parts = path.split("/");
  const file = parts.pop() || path;
  return { dir: parts.length ? `${parts.join("/")}/` : "", file };
}

export function ReviewDock({
  tabs,
  activeId,
  layout,
  multi,
  onLayout,
  onActivate,
  onCloseTab,
  onCloseDiff,
}: {
  tabs: ReviewTab[];
  activeId: string | null;
  layout: DiffLayout;
  multi: boolean;
  onLayout: (layout: DiffLayout) => void;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseDiff: () => void;
}) {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active) return null;
  const lang = syntaxLang(active.view.language, active.view.title);
  const path = fileName(active.view.title);
  const diff = active.view.diff;
  const pathLabel = (
    <span className="review-dock__path" title={active.view.title}>
      <span className="review-dock__dir">{path.dir}</span>
      <span className="review-dock__file">{path.file}</span>
    </span>
  );
  const from = multi && (
    <span className="review-dock__from">
      from <BackendLogo backend={active.backend} size={11} />{" "}
      {active.sessionTitle}
    </span>
  );

  return (
    <section className="review-dock" aria-label="Diff">
      <div className="review-dock__tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`review-dock__tab${tab.id === active.id ? " is-active" : ""}`}
            onClick={() => onActivate(tab.id)}
          >
            <BackendLogo backend={tab.backend} size={12} />
            {fileName(tab.view.title).file}
            {tab.id === active.id && diff && (
              <span className="review-dock__badge">diff</span>
            )}
            <span
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button
          type="button"
          className="review-dock__x"
          aria-label="Close panel"
          onClick={onCloseDiff}
        >
          ×
        </button>
      </div>
      {diff ? (
        <DiffView
          key={active.id}
          diff={diff}
          path={active.view.title}
          lead={pathLabel}
          tail={from}
        />
      ) : (
        <>
          <div className="dview__bar">
            {pathLabel}
            {from}
          </div>
          <div className="dview__body">
            <PlainRows content={active.view.content} lang={lang} />
          </div>
        </>
      )}
    </section>
  );
}

function PlainRows({ content, lang }: { content?: string; lang: SyntaxLang }) {
  return (
    <>
      {(content ?? "").split("\n").map((line, index) => (
        <div key={index} className="rdiff__line rdiff__plain">
          <span>{index + 1}</span>
          <span>
            <SynText text={line} lang={lang} />
          </span>
        </div>
      ))}
    </>
  );
}
