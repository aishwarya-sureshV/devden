import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { SESSION_POINTER_DRAG, SESSION_DRAG_TYPE, parseSessionDrag, sessionTabGroup, type SessionDrag, dockGeometry, fitDock, moveDock, nearestDockEdge, resizeDock, syncDock, validDock, type DockEdge, type DockTree, sidePaneRatio } from "../lib/dockLayout";
import { BackendLogo } from "./icons";
import { TabMenu, type TabMenuItem } from "./TabMenu";
import "../styles/dockLayout.css";

export type DockPanel = { backend?: string; tone?: string; id: string; layoutId?: string; title: string; content: ReactNode; session?: boolean; hidden?: boolean };

// Flat, keyed slots keep editors, chat drafts and PTYs mounted while the split tree changes.
const panelId = (panel: DockPanel) => panel.layoutId ?? panel.id;

// Pane headers that double as drag handles (buttons inside them still click).
const PANE_HEAD = ".review-dock__tabs, .workspace-explorer__search";

// A split's size in px along its axis (rects are percentages of the dock).
const splitExtent = (axis: "x" | "y", rect: { width: number; height: number }, box: { width: number; height: number }) =>
  axis === "x" ? rect.width / 100 * box.width : rect.height / 100 * box.height;

function SessionTabHost({ id, onHost }: { id: string; onHost?: (id: string, node: HTMLDivElement | null) => void }) {
  const ref = useCallback((node: HTMLDivElement | null) => onHost?.(id, node), [id, onHost]);
  return <div className="session-tabstrip__host" ref={ref} />;
}

export function DockLayout({ onTabHost, onNewSession, panels, storageKey, maximized, className = "", toolbar, activeSession, onSessionActivate, onSessionDrop, onSessionTabsChange, onSessionClose, focusMode }: {
  onTabHost?: (id: string, node: HTMLDivElement | null) => void;
  onNewSession?: () => void;
  panels: DockPanel[]; storageKey: string; maximized?: string | null; className?: string; toolbar?: ReactNode;
  activeSession?: string;
  onSessionActivate?: (key: string) => void;
  onSessionDrop?: (data: SessionDrag, asTab: boolean) => string | null;
  onSessionTabsChange?: (keys: string[]) => void;
  onSessionClose?: (key: string) => void;
  /** Not in split mode: every newly focused session joins the tab strip. */
  focusMode?: boolean;
}) {
  const [saved, setSaved] = useState<DockTree | null>(() => {
    try { const value = JSON.parse(localStorage.getItem(`${storageKey}.v2`) ?? "null"); return validDock(value) ? value : null; }
    catch { return null; }
  });
  const [group, setGroup] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem(`${storageKey}.tabs`) ?? "[]");
      return Array.isArray(value) && value.every(id => typeof id === "string") ? [...new Set<string>(value)] : [];
    } catch { return []; }
  });
  const members = group.filter(id => panels.some(p => p.session && panelId(p) === id));
  const activePanel = panels.find(p => p.id === activeSession);
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const selected = activePanel && members.includes(panelId(activePanel)) ? panelId(activePanel) :
    selectedTab && members.includes(selectedTab) ? selectedTab : members[0];
  const layoutIds = (tabs: string[]) => [...new Set(panels.filter(p => !p.hidden || tabs.includes(panelId(p)))
    .map(p => tabs.includes(panelId(p)) ? tabs[0] : panelId(p)))];
  const ids = layoutIds(members);
  const tree = syncDock(saved, ids);
  const { panes, splits } = dockGeometry(tree);
  const tabKeys = members.map(id => panels.find(p => panelId(p) === id)!.id).join(",");
  useEffect(() => { onSessionTabsChange?.(tabKeys ? tabKeys.split(",") : []); }, [tabKeys, onSessionTabsChange]);
  const saveGroup = (next: string[]) => {
    setGroup(next);
    try { localStorage.setItem(`${storageKey}.tabs`, JSON.stringify(next)); } catch { /* Optional storage. */ }
  };
  const [pending, setPending] = useState<{ key: string; target: string; edge: DockEdge | "tabs" } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cleanup = useRef<() => void>(() => {});
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; edge: DockEdge | "tabs" } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Retain closed panes' positions in saved; only prune the rendered tree.
  const commit = (next: DockTree | null) => {
    setSaved(next);
    try { localStorage.setItem(`${storageKey}.v2`, JSON.stringify(next)); } catch { /* Layout still works without storage. */ }
  };
  useEffect(() => () => cleanup.current(), []);
  // Window/dock shrinks: re-clamp so no pane drops under its minimum (panes never overlap).
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (!tree || typeof tree === "string") return;
      const fitted = fitDock(tree, node.clientWidth, node.clientHeight);
      if (fitted && JSON.stringify(fitted) !== JSON.stringify(tree)) commit(fitted);
    });
    observer.observe(node);
    return () => observer.disconnect();
  });
  // The explorer asks for room when a file opens (px) and gives it back when it closes (null).
  useEffect(() => {
    const onWidth = (event: Event) => {
      let want = (event as CustomEvent<number | null>).detail;
      const split = splits.find(s => s.node.axis === "x" && s.node.second === "workspace");
      if (!split || !root.current || !tree) return;
      const extent = splitExtent("x", split.rect, root.current.getBoundingClientRect());
      const current = (1 - split.node.ratio) * extent;
      // Never squeeze the conversation below ~45% of the row; this also
      // repairs a saved layout that already did (e.g. ratio 0.1).
      const cap = extent * 0.55;
      if (want !== null) want = Math.min(want, cap);
      if (want !== null && current >= want && current <= cap) return;
      commit(resizeDock(tree, split.path, want === null ? sidePaneRatio(extent) : 1 - want / extent, extent));
    };
    window.addEventListener("devden:side-pane-width", onWidth);
    return () => window.removeEventListener("devden:side-pane-width", onWidth);
  });
  // First run: the explorer opens at its mock width in pixels, not a share of the window.
  useLayoutEffect(() => {
    const width = root.current?.clientWidth;
    if (saved || !width || typeof tree !== "object" || tree?.second !== "workspace") return;
    commit({ ...tree, ratio: sidePaneRatio(width) });
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const attachTab = (id: string, previous?: string) => {
    const first = panels.find(p => p.session && !p.hidden && panelId(p) !== id);
    const next = sessionTabGroup(members, id, previous ?? (first ? panelId(first) : undefined));
    saveGroup(next);
    setSelectedTab(id);
    const panel = panels.find(p => panelId(p) === id);
    if (panel) onSessionActivate?.(panel.id);
    commit(syncDock(tree, layoutIds(next)));
    setAnnouncement(`${panel?.title} added to session tabs`);
  };
  // Focusing a session from the sidebar opens it as a tab beside the one you
  // were in; a session opened beside another keeps its split.
  // Sessions always read as tabs: a lone session still gets its tab.
  useEffect(() => {
    const first = panels.find(p => p.session && !p.hidden);
    if (!members.length && first && !maximized) attachTab(panelId(first));
  });
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    const active = activePanel?.session ? panelId(activePanel) : null;
    const prev = lastActive.current;
    if (active) lastActive.current = active;
    if (!active || !prev || prev === active || members.includes(active)) return;
    // In focus mode the visible panes ARE the tabs, so they never mean "split".
    if (!focusMode && panels.some(p => p.session && !p.hidden && panelId(p) !== active)) return;
    attachTab(active, panels.some(p => p.session && panelId(p) === prev) ? prev : undefined);
  });
  const move = (id: string, target: string, edge: DockEdge) => {
    const next = members.filter(member => member !== id);
    const targetId = next.includes(target) ? next[0] : target;
    const base = syncDock(tree, [...new Set([...layoutIds(next), id])]);
    if (!base || id === targetId) return;
    const box = root.current?.getBoundingClientRect();
    const moved = moveDock(base, id, targetId, edge);
    const fitted = box ? fitDock(moved, box.width, box.height) : moved;
    if (!fitted) {
      window.dispatchEvent(new CustomEvent("devden:toast", { detail: "Not enough room for another pane — each session needs at least 300px." }));
      return;
    }
    saveGroup(members.filter(member => member !== id));
    commit(fitted);
    setAnnouncement(`${panels.find(p => panelId(p) === id)?.title} moved ${edge} of ${panels.find(p => panelId(p) === target)?.title}`);
  };
  const tabMenuItems = (id: string): TabMenuItem[] => {
    const menuIds = [...new Set([...members, ...panels.filter(p => p.session && !p.hidden).map(panelId)])];
    const index = menuIds.indexOf(id);
    const others = menuIds.filter(member => member !== id);
    const right = menuIds.slice(index + 1);
    const close = (ids: string[]) => {
      saveGroup(members.filter(member => !ids.includes(member)));
      for (const member of ids) onSessionClose?.(panels.find(p => panelId(p) === member)!.id);
    };
    const split = (edge: DockEdge) => () => { if (others.length) move(id, others[0], edge); };
    return [
      { label: "Close", onSelect: () => close([id]) },
      { label: "Close Others", onSelect: () => close(others), disabled: !others.length },
      { label: "Close to the Right", onSelect: () => close(right), disabled: !right.length },
      { label: "Close All", onSelect: () => close(menuIds) },
      "separator",
      { label: "Split Right", onSelect: split("right"), disabled: !others.length },
      { label: "Split Down", onSelect: split("bottom"), disabled: !others.length },
    ];
  };
  useEffect(() => {
    if (!pending) return;
    const panel = panels.find(p => p.id === pending.key);
    if (!panel) return;
    if (pending.edge === "tabs") attachTab(panelId(panel));
    else move(panelId(panel), pending.target, pending.edge);
    setPending(null);
  }, [pending, panels]);
  const nativeDrop = (event: React.DragEvent, target: string, edge: DockEdge | "tabs") => {
    const data = parseSessionDrag(event.dataTransfer.getData(SESSION_DRAG_TYPE));
    if (!data || !onSessionDrop) return;
    event.preventDefault(); event.stopPropagation();
    const key = onSessionDrop(data, edge === "tabs");
    if (key) setPending({ key, target, edge });
    setHint(null);
  };
  const drag = (event: Pick<PointerEvent<HTMLButtonElement>, "button" | "pointerId" | "clientX" | "clientY" | "preventDefault">, id: string, external?: SessionDrag) => {
    if (event.button !== 0 || maximized) return;
    event.preventDefault();
    cleanup.current();
    let destination: typeof hint = null;
    let started = false;
    const x = event.clientX, y = event.clientY;
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (!started && Math.hypot(e.clientX - x, e.clientY - y) < 5) return;
      started = true;
      setDragging(id);
      const slot = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-dock-id]");
      const strip = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-session-tabstrip]");
      const isSession = !!external || panels.some(p => p.session && panelId(p) === id);
      destination = isSession && strip && root.current?.parentElement?.contains(strip) ? { id: "tabs", edge: "tabs" } : slot && root.current?.contains(slot) && slot.dataset.dockId !== id ? {
        id: slot.dataset.dockId!, edge: nearestDockEdge(e.clientX - slot.getBoundingClientRect().left,
          e.clientY - slot.getBoundingClientRect().top, slot.clientWidth, slot.clientHeight),
      } : null;
      setHint(destination);
    };
    const finish = () => { cleanup.current(); setDragging(null); setHint(null); };
    const onUp = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (destination && external && onSessionDrop) {
        const key = onSessionDrop(external, destination.edge === "tabs");
        if (key) setPending({ key, target: destination.id, edge: destination.edge });
      } else if (destination?.edge === "tabs") attachTab(id);
      else if (destination) {
        const panel = panels.find(p => panelId(p) === id);
        if (panel?.session) onSessionDrop?.({ key: panel.id }, false);
        move(id, destination.id, destination.edge);
      }
      finish();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(); } };
    const cancel = () => finish();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", onKey);
      cleanup.current = () => {};
    };
  };
  useEffect(() => {
    const start = (event: Event) => {
      const { data, ...pointer } = (event as CustomEvent<{ data: SessionDrag; button: number; pointerId: number; clientX: number; clientY: number }>).detail;
      drag({ ...pointer, preventDefault: () => {} }, "sidebar-session", data);
    };
    window.addEventListener(SESSION_POINTER_DRAG, start);
    return () => window.removeEventListener(SESSION_POINTER_DRAG, start);
  });
  const sessionPanes = new Set(panels.filter(p => p.session && !p.hidden && !(members.includes(panelId(p)) && selected !== panelId(p))).map(p => members.includes(panelId(p)) ? members[0] : panelId(p))).size;
  // The session header is the drag handle for the focused session.
  const toolbarBox = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const reveal = () => {
      const active = strip.querySelector<HTMLElement>('.session-tabstrip__activation[aria-selected="true"]')?.closest<HTMLElement>(".session-tabstrip__tab");
      if (!active) return;
      const box = active.getBoundingClientRect();
      const bounds = strip.getBoundingClientRect();
      if (box.left < bounds.left) strip.scrollLeft += box.left - bounds.left;
      else if (box.right > bounds.right) strip.scrollLeft += box.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeSession, tabKeys]);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  useEffect(() => {
    const box = toolbarBox.current;
    if (!box) return;
    const down = (event: globalThis.PointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest("button, input, a, select, textarea, [role=menu], [role=dialog]")) return;
      const active = panels.find(p => p.session && p.id === activeSession);
      if (active) dragRef.current(event as unknown as PointerEvent, panelId(active));
    };
    box.addEventListener("pointerdown", down);
    return () => box.removeEventListener("pointerdown", down);
  });
  const stripIds = [...new Set([...members, ...panels.filter(p => p.session && !p.hidden).map(panelId)])];
  return <div className="dock-workspace">
    {panels.some(p => p.session) && !maximized && <div data-session-tabstrip className={`session-tabstrip${hint?.edge === "tabs" ? " is-drop-target" : ""}`}
      role="tablist" aria-label="Session tabs"
      onDragOver={event => {
        if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        setHint({ id: "tabs", edge: "tabs" });
      }} onDragLeave={() => setHint(null)} onDrop={event => nativeDrop(event, "tabs", "tabs")}>
      <div className="session-tabstrip__tabs" ref={tabStrip}>
      {stripIds.map(id => {
        const panel = panels.find(p => panelId(p) === id)!;
        return <div key={panel.id} className="session-tabstrip__tab">
          <div className="session-tabstrip__activation" aria-selected={panel.id === activeSession || (!activeSession && selected === id)} 
            draggable onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify({ key: panel.id })); }}
            onPointerDown={event => { if (!(event.target as Element).closest("button, input, [role=dialog], [role=menu]")) drag(event, id); }}
            onClick={() => { setSelectedTab(id); onSessionActivate?.(panel.id); }}
            onContextMenu={event => { event.preventDefault(); setTabMenu({ id, x: event.clientX, y: event.clientY }); }}
            onKeyDown={event => {
              if ((event.target as Element).closest("input, [role=dialog], [role=menu]")) return;
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const index = (stripIds.indexOf(id) + (event.key === "ArrowRight" ? 1 : -1) + stripIds.length) % stripIds.length;
              setSelectedTab(stripIds[index]); onSessionActivate?.(panels.find(p => panelId(p) === stripIds[index])!.id);
              event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
            }}>{panel.tone
              ? <span className="session-tabstrip__status" data-tone={panel.tone} role="img" aria-label={{ running: "Working", done: "Finished, not opened", waiting: "Waiting for you" }[panel.tone] ?? panel.tone} />
              : <span className="session-tabstrip__logo"><BackendLogo backend={panel.backend ?? ""} size={13} /></span>}<SessionTabHost id={panel.id} onHost={onTabHost} /></div>
          <button type="button" aria-label={`Close tab ${panel.title}`} onClick={() => {
            saveGroup(members.filter(member => member !== id)); onSessionClose?.(panel.id);
          }}>×</button>
        </div>;
      })}
      {onNewSession && <button type="button" className="session-tabstrip__new" onClick={onNewSession} aria-label="New session" title="New session">+</button>}
      </div>
      {toolbar && <div className="dock-toolbar" ref={toolbarBox}>{toolbar}</div>}
      {tabMenu && stripIds.includes(tabMenu.id) && <TabMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.id)} onClose={() => setTabMenu(null)} />}
      {(dragging || hint) && <span className="session-tabstrip__hint">{hint?.edge === "tabs" ? "Drop to add a session tab" : "Drop here to open as a tab"}</span>}
    </div>}
    <div ref={root} className={`dock-layout ${className}${dragging ? " is-dragging" : ""}`}>
    {panels.map(panel => {
      const grouped = members.includes(panelId(panel));
      const rect = maximized === panel.id ? { x: 0, y: 0, width: 100, height: 100 } : panes[grouped ? members[0] : panelId(panel)];
      const hidden = (grouped ? selected !== panelId(panel) : panel.hidden) || !rect || (!!maximized && maximized !== panel.id);
      return <div key={panel.id} id={`dock-${panel.id}`} role={grouped ? "tabpanel" : undefined} aria-label={grouped ? panel.title : undefined}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE) || maximized) return;
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
          const bounds = event.currentTarget.getBoundingClientRect();
          setHint({ id: panelId(panel), edge: nearestDockEdge(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height) });
        }}
        onDrop={event => { if (hint && hint.edge !== "tabs") nativeDrop(event, panelId(panel), hint.edge); }}
        onPointerDown={event => {
          const head = (event.target as Element).closest(PANE_HEAD);
          if (!head || !event.currentTarget.contains(head) || (event.target as Element).closest("button, input, a, select, textarea, [role=menu]")) return;
          drag(event, panelId(panel));
        }}
        data-dock-id={panelId(panel)} className={`dock-slot${panel.session && sessionPanes > 1 ? " is-session" : ""}${panel.session && sessionPanes > 1 && panel.id === activeSession ? " is-focused" : ""}`} hidden={hidden}
        tabIndex={-1}
        style={rect ? { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` } : undefined}>
        {(!panel.session || sessionPanes > 1) && <div className="dock-handlebar">
          <button type="button" className="dock-handle" onPointerDown={e => drag(e, panelId(panel))}
            aria-label={`Drag ${panel.title} to dock`} title={`${panel.title} — drag to another pane’s edge or the tab strip; Escape cancels`}>
            <span className="drag-grip" aria-hidden="true" />
          </button>
        </div>}
        <div className="dock-content">{panel.content}</div>
        {hint?.id === panelId(panel) && hint.edge !== "tabs" && <div className={`dock-preview is-${hint.edge}`} aria-hidden="true">{`Split ${hint.edge}`}</div>}
      </div>;
    })}
    {!maximized && splits.map(({ path, node, rect }) => <button type="button" key={path} className={`dock-resizer is-${node.axis}`}
      role="separator" aria-label="Resize panes" aria-orientation={node.axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(node.ratio * 100)} aria-valuemin={10} aria-valuemax={90}
      style={node.axis === "x" ? { left: `${rect.x + rect.width * node.ratio}%`, top: `${rect.y}%`, height: `${rect.height}%` } :
        { left: `${rect.x}%`, top: `${rect.y + rect.height * node.ratio}%`, width: `${rect.width}%` }}
      onDoubleClick={() => commit(resizeDock(tree!, path, node.axis === "x" && node.second === "workspace" ? sidePaneRatio(splitExtent(node.axis, rect, root.current!.getBoundingClientRect())) : 0.5, splitExtent(node.axis, rect, root.current!.getBoundingClientRect())))}
      onKeyDown={e => {
        const backward = node.axis === "x" ? "ArrowLeft" : "ArrowUp", forward = node.axis === "x" ? "ArrowRight" : "ArrowDown";
        if (e.key !== backward && e.key !== forward) return;
        e.preventDefault();
        const box = root.current!.getBoundingClientRect();
        commit(resizeDock(tree!, path, node.ratio + (e.key === forward ? 0.05 : -0.05), splitExtent(node.axis, rect, box)));
      }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); cleanup.current();
        e.currentTarget.setPointerCapture(e.pointerId);
        const bounds = root.current!.getBoundingClientRect();
        let next = tree!;
        const onMove = (event: globalThis.PointerEvent) => {
          const position = node.axis === "x" ? (event.clientX - bounds.left) / bounds.width * 100 : (event.clientY - bounds.top) / bounds.height * 100;
          next = resizeDock(tree!, path, (position - (node.axis === "x" ? rect.x : rect.y)) / (node.axis === "x" ? rect.width : rect.height), splitExtent(node.axis, rect, bounds));
          setSaved(next);
        };
        const finish = () => { cleanup.current(); commit(next); };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
        cleanup.current = () => {
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish);
          cleanup.current = () => {};
        };
      }} />)}
    <span className="dock-announcement" role="status">{announcement}</span>
  </div></div>;
}
