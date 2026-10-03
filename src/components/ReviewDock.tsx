import type { ToolFileView } from "../lib/toolCards";
import { syntaxLang, type SyntaxLang } from "../lib/syntaxPaint";
import { DiffView } from "./DiffView";
import { BackendLogo } from "./icons";
import { SynText } from "./SynText";
import { useState } from "react";
import { TabMenu } from "./TabMenu";

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

/** Last meaningful segment: "a/b/" -> "b", ignoring empty parts. */
function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
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
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuItems = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const others = tabs.filter((tab) => tab.id !== id);
    const right = tabs.slice(index + 1);
    return [
      { label: "Close", onSelect: () => onCloseTab(id) },
      { label: "Close Others", onSelect: () => others.forEach((tab) => onCloseTab(tab.id)), disabled: !others.length },
      { label: "Close to the Right", onSelect: () => right.forEach((tab) => onCloseTab(tab.id)), disabled: !right.length },
      { label: "Close All", onSelect: onCloseDiff },
    ];
  };
  if (!active) return null;
  const lang = syntaxLang(active.view.language, active.view.title);
  const diff = active.view.diff;
  // Hover keeps the full path; the label is just the file's name.
  const pathLabel = (
    <span className="review-dock__path" title={active.view.title}>
      <span className="review-dock__file">{fileName(active.view.title)}</span>
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
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
            }}
          >
            <BackendLogo backend={tab.backend} size={12} />
            {fileName(tab.view.title)}
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
        {menu && tabs.some((tab) => tab.id === menu.id) && (
          <TabMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />
        )}
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
