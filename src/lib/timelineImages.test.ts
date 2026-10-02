import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHistoryImages } from "./timeline.ts";

test("extractHistoryImages reads pi and Anthropic image blocks", () => {
  assert.deepEqual(
    extractHistoryImages([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "image", source: { type: "base64", data: "BBB", media_type: "image/jpeg" } },
      { type: "image", source: { type: "url", url: "https://x" } },
    ]),
    ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"],
  );
});
