import assert from "node:assert/strict";
import { test } from "node:test";
import { columns, dwindle, masterStack } from "../dist/layouts.js";

const area = { x: 0, y: 0, width: 1000, height: 600 };

test("dwindle splits the remaining space along its longer side", () => {
  const [a, b, c] = dwindle([1, 2, 3], area, { gap: 10, outer: 20 });
  assert.deepEqual(a, { key: 1, x: 20, y: 20, width: 475, height: 560 });
  assert.deepEqual(b, { key: 2, x: 505, y: 20, width: 475, height: 275 });
  assert.deepEqual(c, { key: 3, x: 505, y: 305, width: 475, height: 275 });
});

test("master-stack and columns keep the requested window in view", () => {
  const [master, ...stack] = masterStack(["m", "s1", "s2"], area, { ratio: 0.6 });
  assert.equal(master.width, 600);
  assert.deepEqual(stack.map((box) => [box.x, box.height]), [[600, 300], [600, 300]]);
  const { placements, scroll } = columns([1, 2, 3, 4], area, { width: 0.5, focused: 4 });
  assert.equal(scroll, 1000);
  assert.equal(placements[3].x + placements[3].width, area.width);
});
