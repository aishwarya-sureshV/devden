export type DockEdge = "left" | "right" | "top" | "bottom";
export type DockTree = string | { axis: "x" | "y"; ratio: number; first: DockTree; second: DockTree };
export type DockRect = { x: number; y: number; width: number; height: number };

export function dockIds(tree: DockTree | null): string[] {
  return tree === null ? [] : typeof tree === "string" ? [tree] : [...dockIds(tree.first), ...dockIds(tree.second)];
}

export function removeDock(tree: DockTree | null, id: string): DockTree | null {
  if (tree === null || tree === id) return null;
  if (typeof tree === "string") return tree;
  const first = removeDock(tree.first, id), second = removeDock(tree.second, id);
  return first === null ? second : second === null ? first : { ...tree, first, second };
}

export function moveDock(tree: DockTree, id: string, target: string, edge: DockEdge): DockTree {
  if (id === target || !dockIds(tree).includes(id) || !dockIds(tree).includes(target)) return tree;
  const remaining = removeDock(tree, id)!;
  const insert = (node: DockTree): DockTree => {
    if (node === target) {
      const before = edge === "left" || edge === "top";
      return { axis: edge === "left" || edge === "right" ? "x" : "y", ratio: 0.5,
        first: before ? id : target, second: before ? target : id };
    }
    return typeof node === "string" ? node : { ...node, first: insert(node.first), second: insert(node.second) };
  };
  return insert(remaining);
}

/** The file explorer docks at the far right by default; panes opened later land left of it. */
const SIDE_PANE = "workspace";
export const SIDE_PANE_RATIO = 0.78;
/** The explorer's default width in pixels (the mock's 248px tree + chrome). */
export const SIDE_PANE_PX = 264;
export const sidePaneRatio = (width: number) => Math.max(0.5, Math.min(0.9, 1 - SIDE_PANE_PX / width));

export function defaultDock(ids: string[], axis: "x" | "y" = "x"): DockTree | null {
  if (ids.length > 1 && ids.includes(SIDE_PANE)) return { axis: "x", ratio: SIDE_PANE_RATIO,
    first: defaultDock(ids.filter(id => id !== SIDE_PANE))!, second: SIDE_PANE };
  if (ids.length < 2) return ids[0] ?? null;
  const middle = Math.ceil(ids.length / 2);
  return { axis, ratio: middle / ids.length,
    first: defaultDock(ids.slice(0, middle), axis === "x" ? "y" : "x")!,
    second: defaultDock(ids.slice(middle), axis === "x" ? "y" : "x")! };
}

export function syncDock(tree: DockTree | null, ids: string[]): DockTree | null {
  if (tree === null) return defaultDock(ids);
  for (const id of dockIds(tree)) if (!ids.includes(id)) tree = removeDock(tree, id);
  for (const id of ids) if (!dockIds(tree).includes(id))
    tree = tree === null ? id : insertBeforeSide(tree, id) ?? { axis: "x", ratio: 0.7, first: tree, second: id };
  return tree;
}

/** Puts `id` just left of the explorer when the explorer still sits on a right edge. */
function insertBeforeSide(tree: DockTree, id: string): DockTree | null {
  if (tree === SIDE_PANE) return { axis: "x", ratio: SIDE_PANE_RATIO, first: id, second: SIDE_PANE };
  if (typeof tree === "string") return null;
  if (tree.axis === "x" && tree.second === SIDE_PANE)
    return { ...tree, first: { axis: "x", ratio: 0.5, first: tree.first, second: id } };
  const second = insertBeforeSide(tree.second, id);
  return second && { ...tree, second };
}

export function validDock(value: unknown, depth = 0): value is DockTree {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object" || depth > 32) return false;
  const node = value as Record<string, unknown>;
  return (node.axis === "x" || node.axis === "y") && typeof node.ratio === "number" &&
    Number.isFinite(node.ratio) && node.ratio >= 0.1 && node.ratio <= 0.9 &&
    validDock(node.first, depth + 1) && validDock(node.second, depth + 1) &&
    new Set(dockIds(value as DockTree)).size === dockIds(value as DockTree).length;
}

export function dockGeometry(tree: DockTree | null) {
  const panes: Record<string, DockRect> = {};
  const splits: Array<{ path: string; node: Exclude<DockTree, string>; rect: DockRect }> = [];
  const walk = (node: DockTree, rect: DockRect, path: string) => {
    if (typeof node === "string") { panes[node] = rect; return; }
    splits.push({ path, node, rect });
    const { x, y, width, height } = rect;
    const r = node.ratio;
    walk(node.first, node.axis === "x" ? { x, y, width: width * r, height } : { x, y, width, height: height * r }, path + "0");
    walk(node.second, node.axis === "x" ? { x: x + width * r, y, width: width * (1 - r), height } :
      { x, y: y + height * r, width, height: height * (1 - r) }, path + "1");
  };
  if (tree !== null) walk(tree, { x: 0, y: 0, width: 100, height: 100 }, "");
  return { panes, splits };
}

// Narrowest/shortest a pane may be dragged to, in CSS px (zoom-aware).
export const MIN_PANE_W = 300;
export const MIN_PANE_H = 160;
// Tool panes (explorer) may shrink further; only conversations keep MIN_PANE_W.
const MIN_SIDE_W = 280;
function minExtent(node: DockTree, axis: "x" | "y"): number {
  if (typeof node === "string") return axis === "x" ? (node === SIDE_PANE ? MIN_SIDE_W : MIN_PANE_W) : MIN_PANE_H;
  const first = minExtent(node.first, axis), second = minExtent(node.second, axis);
  return node.axis === axis ? first + second : Math.max(first, second);
}

// extent: the split's size in px along its axis; when given, neither side may shrink below its minimum.
export function resizeDock(tree: DockTree, path: string, ratio: number, extent?: number): DockTree {
  if (typeof tree === "string") return tree;
  if (!path) {
    let lo = 0.1, hi = 0.9;
    if (extent) {
      const min = minExtent(tree.first, tree.axis) / extent, max = 1 - minExtent(tree.second, tree.axis) / extent;
      if (min <= max) { lo = min; hi = max; }
    }
    return { ...tree, ratio: Math.max(lo, Math.min(hi, ratio)) };
  }
  const side = path[0] === "0" ? "first" : "second";
  return { ...tree, [side]: resizeDock(tree[side], path.slice(1), ratio, extent) };
}

export function nearestDockEdge(x: number, y: number, width: number, height: number): DockEdge {
  const distances: [DockEdge, number][] = [["left", x / width], ["right", 1 - x / width], ["top", y / height], ["bottom", 1 - y / height]];
  return distances.reduce((a, b) => a[1] <= b[1] ? a : b)[0];
}

export const SESSION_DRAG_TYPE = "application/x-devden-session";
export type SessionDrag = { key: string } | { path: string };
export function parseSessionDrag(value: string): SessionDrag | null {
  try {
    const data = JSON.parse(value);
    if (typeof data?.key === "string" && data.key) return { key: data.key };
    if (typeof data?.path === "string" && data.path) return { path: data.path };
  } catch { /* Ignore external or malformed drags. */ }
  return null;
}

export function sessionTabGroup(group: string[], id: string, first?: string): string[] {
  return [...new Set([...group, ...(group.length || !first ? [] : [first]), id])];
}

export const SESSION_POINTER_DRAG = "devden:session-pointer-drag";
export function startSessionDrag(event: { button: number; pointerId: number; clientX: number; clientY: number; preventDefault: () => void }, data: SessionDrag) {
  if (event.button !== 0) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent(SESSION_POINTER_DRAG, { detail: {
    data, button: event.button, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
  } }));
}

/** Clamps every split so each pane keeps its minimum px size; null when the panes can't fit at all. */
export function fitDock(tree: DockTree, width: number, height: number): DockTree | null {
  if (minExtent(tree, "x") > width || minExtent(tree, "y") > height) return null;
  const fit = (node: DockTree, w: number, h: number): DockTree => {
    if (typeof node === "string") return node;
    const extent = node.axis === "x" ? w : h;
    const { ratio } = resizeDock(node, "", node.ratio, extent) as Exclude<DockTree, string>;
    const a = extent * ratio, b = extent - a;
    return { ...node, ratio,
      first: fit(node.first, node.axis === "x" ? a : w, node.axis === "x" ? h : a),
      second: fit(node.second, node.axis === "x" ? b : w, node.axis === "x" ? h : b) };
  };
  return fit(tree, width, height);
}
