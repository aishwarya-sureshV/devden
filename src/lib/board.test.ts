import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addCard,
  CARD_TITLE_MAX,
  columnCards,
  leadLine,
  moveCard,
  removeCard,
  renameCard,
  updateCard,
  type BoardCard,
} from "./board.ts";

const seed = (): BoardCard[] => [
  { id: "a", title: "a", column: "backlog" },
  { id: "b", title: "b", column: "backlog" },
  { id: "c", title: "c", column: "doing" },
];

describe("board moves", () => {
  it("drop on empty space appends to the end of the target column", () => {
    const next = moveCard(seed(), "a", "doing");
    assert.deepEqual(
      columnCards(next, "doing").map((card) => card.id),
      ["c", "a"],
    );
    assert.deepEqual(
      columnCards(next, "backlog").map((card) => card.id),
      ["b"],
    );
  });

  it("drop on a card lands before it", () => {
    const next = moveCard(seed(), "a", "doing", "c");
    assert.deepEqual(
      columnCards(next, "doing").map((card) => card.id),
      ["a", "c"],
    );
  });

  it("reorders within one column without changing membership", () => {
    const next = moveCard(seed(), "b", "backlog", "a");
    assert.deepEqual(
      columnCards(next, "backlog").map((card) => card.id),
      ["b", "a"],
    );
    assert.equal(next.length, 3);
  });

  it("moving into an empty column keeps every other column intact", () => {
    const next = moveCard(seed(), "c", "done");
    assert.deepEqual(
      columnCards(next, "done").map((card) => card.id),
      ["c"],
    );
    assert.deepEqual(
      columnCards(next, "backlog").map((card) => card.id),
      ["a", "b"],
    );
    assert.deepEqual(columnCards(next, "doing"), []);
  });

  it("an unknown id is a no-op", () => {
    const cards = seed();
    assert.equal(moveCard(cards, "zz", "done"), cards);
  });
});

describe("board edits", () => {
  it("adds to the end of its column and ignores blank titles", () => {
    const next = addCard(seed(), "  new  ", "backlog", { id: "d" });
    assert.deepEqual(
      columnCards(next, "backlog").map((card) => card.title),
      ["a", "b", "new"],
    );
    assert.equal(addCard(next, "   ", "backlog").length, next.length);
  });

  it("collapses whitespace and caps a pasted paragraph", () => {
    const [card] = addCard([], "  a\n  long   selection  ", "backlog");
    assert.equal(card!.title, "a long selection");
    const long = addCard([], "x".repeat(400), "backlog")[0]!;
    assert.equal(long.title.length, CARD_TITLE_MAX);
    assert.ok(long.title.endsWith("…"));
  });

  it("renames and removes by id", () => {
    assert.equal(renameCard(seed(), "a", "renamed")[0]!.title, "renamed");
    assert.deepEqual(
      removeCard(seed(), "a").map((card) => card.id),
      ["b", "c"],
    );
  });
});

describe("card details", () => {
  it("carries extras onto the new card and patches them later", () => {
    const [card] = addCard([], "from a session", "backlog", {
      sessionPath: "/s/423.jsonl",
    });
    assert.equal(card!.sessionPath, "/s/423.jsonl");

    const noted = updateCard([card!], card!.id, { note: "repro", shot: true });
    assert.equal(noted[0]!.note, "repro");
    assert.equal(noted[0]!.shot, true);
    // The patch must not drop the fields it did not mention.
    assert.equal(noted[0]!.sessionPath, "/s/423.jsonl");
    assert.equal(noted[0]!.title, "from a session");
  });

  it("a move keeps the detail fields attached to the card", () => {
    const seeded = addCard([], "t", "backlog", {
      id: "x",
      note: "n",
      sessionPath: "/s/1.jsonl",
    });
    const moved = moveCard(seeded, "x", "done");
    assert.equal(moved[0]!.note, "n");
    assert.equal(moved[0]!.sessionPath, "/s/1.jsonl");
  });

  it("patching an unknown id is a no-op", () => {
    const cards = seed();
    assert.equal(updateCard(cards, "zz", { note: "x" }), cards);
  });
});

describe("selection titles", () => {
  it("keeps a short line as-is and strips its list marker", () => {
    assert.equal(leadLine("Fold long tool output"), "Fold long tool output");
    assert.equal(
      leadLine("6. Fleet race with a cost scoreboard"),
      "Fleet race with a cost scoreboard",
    );
    assert.equal(leadLine("- Substrate: pool and queue"), "Substrate: pool and queue");
  });

  it("cuts a long single paragraph at its first sentence", () => {
    const paragraph =
      "Your backlog already exists — it is the uncommitted tree. 43 modified " +
      "files, 39 untracked, ~4,100 insertions, zero TODO markers in code.";
    assert.equal(
      leadLine(paragraph),
      "Your backlog already exists — it is the uncommitted tree.",
    );
  });

  it("takes the first line out of a multi-line selection", () => {
    assert.equal(leadLine("Fleet race\nOne task to N backends"), "Fleet race");
  });

  it("falls back to the text when there is no usable sentence break", () => {
    const runOn = "x".repeat(200);
    assert.equal(leadLine(runOn), runOn);
    assert.equal(leadLine("   "), "   ");
  });
});

describe("to-do priority", () => {
  const lane = (): BoardCard[] => [
    { id: "a", title: "a", column: "backlog" },
    { id: "b", title: "b", column: "backlog", priority: "low" },
    { id: "c", title: "c", column: "backlog", priority: "high" },
    { id: "d", title: "d", column: "backlog", priority: "normal" },
    { id: "e", title: "e", column: "doing", priority: "low" },
    { id: "f", title: "f", column: "doing", priority: "high" },
  ];

  it("sorts To-do high first and treats an unset priority as normal", () => {
    assert.deepEqual(
      columnCards(lane(), "backlog").map((card) => card.id),
      ["c", "a", "d", "b"],
    );
  });

  it("keeps the dragged order within one priority", () => {
    const cards = columnCards(lane(), "backlog");
    // "a" (unset) was added before "d" (normal) and stays there.
    assert.ok(cards.indexOf(cards.find((c) => c.id === "a")!) < 
              cards.indexOf(cards.find((c) => c.id === "d")!));
  });

  it("leaves every other lane in board order", () => {
    assert.deepEqual(
      columnCards(lane(), "doing").map((card) => card.id),
      ["e", "f"],
    );
  });

  it("does not reorder the stored board", () => {
    const cards = lane();
    columnCards(cards, "backlog");
    assert.deepEqual(cards.map((card) => card.id), ["a", "b", "c", "d", "e", "f"]);
  });
});
