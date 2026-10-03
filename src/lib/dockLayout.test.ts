import { strict as assert } from "node:assert";
import test from "node:test";
import { parseSessionDrag, sessionTabGroup, defaultDock, dockGeometry, dockIds, moveDock, nearestDockEdge, removeDock, resizeDock, syncDock, validDock, MIN_PANE_W } from "./dockLayout.ts";

test("dock moves preserve all panes, collapse old splits, and tile without overlap", () => {
  let tree = defaultDock(["chat", "files", "terminal", "board"])!;
  assert.ok(validDock(tree));
  assert.equal(dockGeometry(tree).panes.chat.width, 50);
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    tree = moveDock(tree, "terminal", "chat", edge);
    assert.deepEqual(dockIds(tree).sort(), ["board", "chat", "files", "terminal"]);
    const { panes } = dockGeometry(tree);
    const chat = panes.chat, terminal = panes.terminal;
    if (edge === "left") assert.equal(terminal.x + terminal.width, chat.x);
    if (edge === "right") assert.equal(chat.x + chat.width, terminal.x);
    if (edge === "top") assert.equal(terminal.y + terminal.height, chat.y);
    if (edge === "bottom") assert.equal(chat.y + chat.height, terminal.y);
    assert.ok(Math.abs(Object.values(panes).reduce((sum, r) => sum + r.width * r.height, 0) - 10000) < 1e-8);
    assert.ok(validDock(JSON.parse(JSON.stringify(tree))));
  }
  assert.equal(moveDock(tree, "chat", "chat", "left"), tree);
  assert.equal(moveDock(tree, "missing", "chat", "left"), tree);
  assert.deepEqual(dockIds(syncDock(tree, ["chat", "new"])).sort(), ["chat", "new"]);
  assert.equal(removeDock("chat", "chat"), null);
  assert.equal(syncDock(tree, []), null);
  const resized = resizeDock(tree, "", 2);
  assert.equal(typeof resized === "object" && resized.ratio, 0.9);
  assert.ok(validDock(resizeDock(tree, "0", -1)));
  assert.equal(validDock({ axis: "x", ratio: 0.5, first: "chat", second: "chat" }), false);
  assert.equal(validDock({ axis: "x", ratio: NaN, first: "chat", second: "file" }), false);
  assert.equal(validDock({ axis: "z", ratio: 0.5, first: "chat", second: "file" }), false);
  assert.equal(nearestDockEdge(1, 50, 200, 100), "left");
  assert.equal(nearestDockEdge(100, 1, 200, 100), "top");
});


test("session drags accept known identifiers and tab grouping avoids duplicates", () => {
  assert.deepEqual(parseSessionDrag('{"key":"open-session"}'), { key: "open-session" });
  assert.deepEqual(parseSessionDrag('{"path":"/session.jsonl"}'), { path: "/session.jsonl" });
  for (const value of ["", "broken", "null", "{}", '{"key":3}', '{"path":""}']) assert.equal(parseSessionDrag(value), null);
  assert.deepEqual(sessionTabGroup([], "second", "first"), ["first", "second"]);
  assert.deepEqual(sessionTabGroup(["first", "second"], "second", "other"), ["first", "second"]);
  assert.deepEqual(sessionTabGroup(["first", "second"], "third"), ["first", "second", "third"]);
});

test("resizeDock keeps every pane at least MIN_PANE_W wide", () => {
  const tree = { axis: "x" as const, ratio: 0.5, first: "a", second: { axis: "x" as const, ratio: 0.5, first: "b", second: "c" } };
  const hi = resizeDock(tree, "", 1, 1200) as { ratio: number };
  assert.equal(hi.ratio, 1 - 2 * MIN_PANE_W / 1200);
  const lo = resizeDock(tree, "", 0, 1200) as { ratio: number };
  assert.equal(lo.ratio, MIN_PANE_W / 1200);
  assert.equal((resizeDock(tree, "", 0, undefined) as { ratio: number }).ratio, 0.1);
});

test("explorer defaults to the far right and new panes open left of it", () => {
  const tree = defaultDock(["chat", "workspace"])!;
  assert.deepEqual(dockIds(tree), ["chat", "workspace"]);
  assert.deepEqual(dockIds(syncDock(tree, ["chat", "workspace", "review"])), ["chat", "review", "workspace"]);
  assert.deepEqual(dockIds(defaultDock(["chat", "workspace", "review"])), ["chat", "review", "workspace"]);
});

test("fitDock refuses a split that can't keep MIN_PANE_W and widens narrow panes", async () => {
  const { fitDock } = await import("./dockLayout.ts");
  const three = { axis: "x" as const, ratio: 0.5, first: "a", second: { axis: "x" as const, ratio: 0.5, first: "b", second: "c" } };
  assert.equal(fitDock(three, 800, 600), null);
  const fitted = fitDock({ ...three, ratio: 0.1 }, 1200, 600) as { ratio: number };
  assert.ok(fitted.ratio * 1200 >= MIN_PANE_W);
});
