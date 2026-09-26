import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askIncoming,
  firstAsk,
  hasAskBlock,
  isAskMessage,
  messageAsk,
  parseAsk,
} from "./askBlock.ts";

const fence = (body: string) => ["```ask", body, "```"].join("\n");

describe("hasAskBlock", () => {
  it("finds the fence mid-message", () => {
    assert.equal(hasAskBlock(`Two things first.\n\n${fence("{}")}`), true);
  });

  it("ignores other fences", () => {
    assert.equal(hasAskBlock("```json\n{}\n```"), false);
  });
});

describe("parseAsk", () => {
  it("reads the documented shape", () => {
    const questions = parseAsk(
      JSON.stringify({
        questions: [
          {
            header: "Scope",
            question: "Which page?",
            multiSelect: true,
            options: [{ label: "Fleet", description: "the board" }],
          },
        ],
      }),
    );
    assert.deepEqual(questions, [
      {
        header: "Scope",
        question: "Which page?",
        multiSelect: true,
        options: [{ label: "Fleet", description: "the board" }],
      },
    ]);
  });

  it("accepts a bare array and string options", () => {
    assert.deepEqual(parseAsk('[{"question":"Which?","options":["a","b"]}]'), [
      {
        question: "Which?",
        header: undefined,
        multiSelect: false,
        options: [{ label: "a" }, { label: "b" }],
      },
    ]);
  });

  it("returns null for a half-streamed block", () => {
    assert.equal(parseAsk('{"questions":[{"question":"Whi'), null);
  });

  it("returns null when no question carries options", () => {
    assert.equal(parseAsk('{"questions":[{"question":"Which?"}]}'), null);
  });
});

describe("firstAsk", () => {
  const q = (question: string, option: string) =>
    JSON.stringify({
      questions: [{ question, options: [{ label: option }] }],
    });

  it("ignores surrounding prose and a second fence", () => {
    const text = [
      "I will use the ask block format.",
      fence(q("First?", "a")),
      "What changed — nothing.",
      fence(q("Second?", "b")),
    ].join("\n");
    assert.deepEqual(
      firstAsk(text)?.map((row) => row.question),
      ["First?"],
    );
  });

  it("returns null for a half-streamed fence", () => {
    assert.equal(firstAsk('```ask\n{"questions":['), null);
  });
});

describe("messageAsk / isAskMessage", () => {
  const bare = JSON.stringify({
    questions: [{ question: "Which?", options: ["a", "b"] }],
  });

  it("reads a fence-less questions payload", () => {
    assert.deepEqual(
      messageAsk(bare)?.map((row) => row.question),
      ["Which?"],
    );
    assert.equal(isAskMessage(bare), true);
  });

  it("prefers the fence and ignores json code blocks", () => {
    const fenced = `prose\n\n${fence(bare)}`;
    assert.deepEqual(
      messageAsk(fenced)?.map((row) => row.question),
      ["Which?"],
    );
    assert.equal(isAskMessage(fenced), true);
    assert.equal(isAskMessage("```json\n{}\n```"), false);
  });

  it("leaves ordinary prose alone", () => {
    assert.equal(isAskMessage("A question? And **markdown**."), false);
    assert.equal(messageAsk("A question? And **markdown**."), null);
  });

  it("reads a json fence whose body is the questions payload", () => {
    const text = ["```json", bare, "```"].join("\n");
    assert.deepEqual(
      messageAsk(text)?.map((row) => row.question),
      ["Which?"],
    );
    assert.equal(isAskMessage(text), true);
    assert.equal(isAskMessage("```JSON\n" + bare + "\n```"), true);
  });

  it("leaves a json fence that is not an ask alone", () => {
    assert.equal(messageAsk('```json\n{"foo":1}\n```'), null);
    assert.equal(isAskMessage('```json\n{"foo":1}\n```'), false);
    assert.equal(messageAsk("```json\n" + bare), null);
  });

  it("reads an unclosed ask fence whose payload has a glm-5.3 xml tail", () => {
    const text = ["```ask", bare, "</arg_value></tool_call>"].join("\n");
    assert.deepEqual(
      messageAsk(text)?.map((row) => row.question),
      ["Which?"],
    );
    assert.equal(isAskMessage(text), true);
  });
});

describe("askIncoming", () => {
  it("flags a json fence that has started the questions object", () => {
    assert.equal(askIncoming('```json\n{"questions":['), true);
    assert.equal(askIncoming('{"questions":['), true);
    assert.equal(askIncoming("```ask\n{"), true);
  });

  it("is quiet once the payload parses, and for ordinary json", () => {
    const bare = JSON.stringify({
      questions: [{ question: "Which?", options: ["a"] }],
    });
    assert.equal(askIncoming(["```json", bare, "```"].join("\n")), false);
    assert.equal(askIncoming('```json\n{"foo":1}\n```'), false);
  });
});
