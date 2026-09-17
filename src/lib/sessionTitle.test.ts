import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextualSessionTitle, savedSessionTitle } from "./sessionTitle.ts";

describe("contextualSessionTitle", () => {
  it("does not truncate a numbered-list prompt to its number", () => {
    // Regression: a session titled from "6. the tunnel binary/ is missing
    // from this repo. ..." showed as a bare "6" in the sessions panel.
    assert.equal(
      contextualSessionTitle(
        "6. the tunnel binary is missing from this repo. You have a remote feature and the product doesn't consume it.",
        "Untitled session",
      ),
      "The tunnel binary is missing from this repo",
    );
  });

  it("keeps ordinary first sentences", () => {
    assert.equal(
      contextualSessionTitle(
        "Please fix the sidebar titles. They are wrong.",
        "Untitled session",
      ),
      "Fix the sidebar titles",
    );
  });
});

describe("savedSessionTitle", () => {
  it("derives a label when the stored name is the prompt itself", () => {
    assert.equal(
      savedSessionTitle(
        "6. the tunnel binary is missing from this repo",
        "6. the tunnel binary is missing from this repo",
      ),
      "The tunnel binary is missing from this repo",
    );
  });

  it("passes an explicit stored title through", () => {
    assert.equal(
      savedSessionTitle("Remote Tunnel Retrieval Context", "6. x"),
      "Remote Tunnel Retrieval Context",
    );
  });
});
