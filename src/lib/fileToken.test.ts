import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isFileToken } from "./fileToken.ts";

test("isFileToken distinguishes file/path tokens from plain code tokens", () => {
  assert.equal(isFileToken("src/lib/a.ts"), true);
  assert.equal(isFileToken("./timeline"), true);
  assert.equal(isFileToken("conversationSend.ts:276"), true);
  assert.equal(isFileToken("is-focused"), false);
  assert.equal(isFileToken("npm run dev"), false);
  assert.equal(isFileToken("TimelineItem"), false);
});
