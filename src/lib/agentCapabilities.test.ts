// @ts-nocheck — imports the untyped server registry to lockstep flags.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_BACKENDS } from "./api.ts";
import { capabilitiesFor } from "./agentCapabilities.ts";
import {
  AGENT_BACKENDS as serverBackends,
  capabilitiesFor as serverCapabilitiesFor,
} from "../../server/agent-registry.js";

describe("agent capabilities stay in lockstep with the server", () => {
  it("lists the same backends", () => {
    assert.deepEqual([...AGENT_BACKENDS], [...serverBackends]);
  });

  it("matches every flag the server advertises", () => {
    for (const backend of AGENT_BACKENDS) {
      assert.deepEqual(
        capabilitiesFor(backend),
        serverCapabilitiesFor(backend),
        backend,
      );
    }
  });
});
