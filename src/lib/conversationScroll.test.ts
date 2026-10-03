import { strict as assert } from "node:assert";
import { test } from "node:test";
import { syncConversationScroll } from "./conversationScroll.ts";

test("new prompts get a viewport, streaming consumes it, history stays readable", () => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ paddingTop: "12px" }) as CSSStyleDeclaration;
  try {
    let promptOffset = 1012;
    let contentHeight = 100;
    const spacer = {
      style: { height: "0px" },
      getBoundingClientRect: () => ({ height: parseFloat(spacer.style.height) }),
    };
    const prompt = {
      dataset: { currentPrompt: "second:0" },
      getBoundingClientRect: () => ({ top: promptOffset - el.scrollTop }),
    };
    const column = {
      getBoundingClientRect: () => ({
        bottom: promptOffset - el.scrollTop + contentHeight + parseFloat(spacer.style.height),
      }),
    };
    const el = {
      clientHeight: 600,
      scrollTop: 50,
      get scrollHeight() {
        return promptOffset + contentHeight + parseFloat(spacer.style.height);
      },
      getBoundingClientRect: () => ({ top: 0 }),
      querySelector: (selector: string) => ({
        ".conversation__column": column,
        "[data-current-prompt]": prompt,
        ".conversation__spacer": spacer,
      })[selector],
    };
    const follow = { current: false };
    const last = { current: "first:0" };
    const sync = () => syncConversationScroll(el as unknown as HTMLElement, follow, last);

    sync(); // Sending while reading old history still focuses the new prompt.
    assert.equal(el.scrollTop, 1000);
    assert.equal(spacer.style.height, "488px");
    assert.equal(follow.current, true);

    contentHeight = 300;
    sync();
    assert.equal(el.scrollTop, 1000); // Prompt stays put as the reply grows.
    assert.equal(spacer.style.height, "288px");

    contentHeight = 900;
    sync();
    assert.equal(spacer.style.height, "0px");
    assert.equal(el.scrollTop, 1312); // Follow once the response fills the viewport.

    follow.current = false;
    el.scrollTop = 400;
    contentHeight = 1000;
    sync();
    assert.equal(el.scrollTop, 400); // Streaming never pulls a history reader down.

    promptOffset = 2012;
    prompt.dataset.currentPrompt = "queued:0";
    contentHeight = 100;
    sync();
    assert.equal(el.scrollTop, 2000); // A queued prompt anchors when it becomes visible.

    el.clientHeight = 400;
    sync();
    assert.equal(spacer.style.height, "288px");
    assert.equal(el.scrollTop, 2000);

    prompt.dataset.currentPrompt = "queued:1";
    follow.current = false;
    el.scrollTop = 0;
    sync();
    assert.equal(el.scrollTop, 2000); // Edit-and-resend also starts at its prompt.
  } finally {
    globalThis.getComputedStyle = original;
  }
});
