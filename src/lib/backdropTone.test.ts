import assert from "node:assert/strict";
import { it } from "node:test";
import { deepShade, dominantRgb } from "./backdropTone.ts";

it("picks the dominant hue family and deepens it", () => {
  const green = [40, 110, 60, 255];
  const blue = [60, 90, 200, 255];
  const gray = [120, 120, 120, 255];
  const px = [...green, ...green, ...green, ...blue, ...gray, ...gray, ...gray, ...gray];
  const [r, g, b] = dominantRgb(new Uint8ClampedArray(px))!;
  assert.deepEqual([r, g, b].map(Math.round), [40, 110, 60]);
  const [R, G, B] = deepShade(r, g, b).match(/\d+/g)!.map(Number);
  assert.ok(Math.max(R, G, B) < 60, "deep");
  assert.ok(G > R && G > B, "keeps the green hue");
});
