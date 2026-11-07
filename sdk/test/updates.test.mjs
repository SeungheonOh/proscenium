// Updates that only write the fields of the props that changed send exactly
// what normalizing the whole of every update sends.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { Box, Group, Rect, Text } from "../dist/components.js";
import { Container, createRoot, reconciler } from "../dist/host.js";
import { instant, spring } from "../dist/motion.js";
import { rotate } from "../dist/transform.js";
import { loadSdk, record } from "./random-scenes.mjs";

/** Renders each of FRAMES into a patching container and a normalizing one; returns the commits. */
function both(frames, between = () => {}) {
  const runs = [true, false].map((patch) => {
    const commits = [];
    const container = new Container({ send: (ops) => commits.push(ops), patch });
    const root = createRoot(container, (error) => { throw error; });
    for (const [index, frame] of frames.entries()) {
      reconciler.updateContainerSync(frame, root, null, null);
      reconciler.flushSyncWork();
      container.flush();
      between(container, index);
    }
    container.requestResync();
    container.flush();
    return commits;
  });
  assert.deepEqual(runs[0].map((ops) => JSON.stringify(ops)), runs[1].map((ops) => JSON.stringify(ops)),
                   "patched updates send what normalized ones do");
  return runs[0];
}

const squares = (t) => h(Group, null, Array.from({ length: 3 }, (_, i) =>
  h(Rect, { key: i, x: t * 10 + i, y: t - i, width: 12, height: 12, radius: 3, fill: "#3478f6",
            transition: instant })));

test("moving squares send only their new x and y", () => {
  const commits = both([squares(0), squares(1), squares(2)]);
  assert.deepEqual(commits[1], [
    { op: "set", id: 1, props: { x: 10, y: 1 } },
    { op: "set", id: 2, props: { x: 11, y: 0 } },
    { op: "set", id: 3, props: { x: 12, y: -1 } },
  ]);
  assert.equal(commits.at(-1).find((op) => op.op === "create" && op.id === 1).props.x, 20,
               "a replay sends the patched props whole");
});

test("new objects equal to the old ones change nothing", () => {
  const onPointerDown = () => {};
  const card = (x, color) => h(Rect, {
    x, width: 40, height: 20, fill: { from: color, to: "#000", angle: 90 },
    border: { width: 1, color: "#e5e5ea" }, shadow: { color: "#0003", blur: 8, y: 2 },
    transform: [rotate(15)], transition: { default: spring(), fill: instant }, onPointerDown,
    style: [{ opacity: 0.5 }, false],
  });
  const commits = both([card(0, "#fff"), card(5, "#fff"), card(5, "#fff"), card(5, "#f00")]);
  assert.deepEqual(commits[1], [{ op: "set", id: 1, props: { x: 5 } }]);
  assert.equal(commits.length, 4, "an update changing nothing sends nothing");
  assert.deepEqual(commits[2].map((op) => Object.keys(op.props)), [["shaders"]],
                   "a fill that changed sends the shaders again");
});

test("new handlers reach events without a scene change", () => {
  const heard = [];
  const button = (n) => h(Rect, { x: n, width: 10, height: 10, onPointerDown: () => heard.push(n) });
  const commits = both([button(1), button(1), button(2)], (container) => {
    container.dispatch({ type: "event", node: 1, name: "pointerdown" });
  });
  assert.equal(commits.length, 3, "only the move and the replay follow the first commit");
  assert.deepEqual(heard, [1, 1, 2, 1, 1, 2]);
});

test("layout props, sizes layout drops and Text content", () => {
  const frame = (margin, width, content, reordered) => {
    const props = reordered
      ? { width, size: 12, color: "#fff" }
      : { color: "#fff", size: 12, width };
    return h(Box, { x: 10, width: 200, padding: 4, flexDirection: "column" },
      h(Rect, { height: 10, margin, flexGrow: 1 }),
      h(Text, props, content),
      h(Text, { size: 12, text: "fixed" }, content === "a" ? "a" : h(Text, { weight: "bold" }, "b")));
  };
  const commits = both([
    frame(0, 100, "a", false), frame(4, 100, "a", false), frame(4, "50%", "a", false),
    frame(4, "50%", ["n = ", 2], false), frame(4, 50, ["n = ", 2], true), frame(8, 50, "b", true),
  ]);
  const sets = commits.slice(0, -1).flat().filter((op) => op.op === "set");
  assert.ok(sets.some((op) => op.props.y === 8), "a margin moves what it lays out");
  assert.ok(sets.some((op) => op.props.text === "n = 2"), "Text content is its text");
});

test("hidden nodes stay hidden through updates", () => {
  const commits = both([squares(0), squares(1), squares(2), squares(3)], (container, index) => {
    const node = container.instances.get(2);
    if (index === 0) container.setHidden(node, true);
    if (index === 2) container.setHidden(node, false);
    container.flush();
  });
  const create = commits.at(-1).find((op) => op.op === "create" && op.id === 2);
  assert.equal(create.props.visible, undefined);
  assert.ok(commits.some((ops) => ops.some((op) => op.id === 2 && op.props?.visible === false)));
});

test("values holding NaN go on being sent as before", () => {
  // A gradient is no text color: it reaches the wire as NaNs, which never equal
  // themselves, so each update sends them again, however unchanged the prop.
  const gradient = { from: "#fff", to: "#000" };
  const border = { width: NaN };
  const label = (x) => h(Text, { x, color: gradient, opacity: NaN }, "NaN");
  const box = (x) => h(Rect, { x, border });
  assert.deepEqual(both([label(0), label(1), label(1)]).slice(1, -1).map((ops) => Object.keys(ops[0].props)),
                   [["x", "color", "opacity"], ["color", "opacity"]]);
  assert.deepEqual(both([box(0), box(1), box(1)]).slice(1, -1).map((ops) => Object.keys(ops[0].props)),
                   [["x", "shaders"], ["shaders"]]);
});

test("objects equal but for the order of their keys keep the order they come in", () => {
  const square = (x, reversed) => h(Rect, {
    x, width: 10, height: 10, fill: "#fff",
    transition: reversed ? { x: instant, default: spring() } : { default: spring(), x: instant },
    style: reversed ? { margin: 2, opacity: 0.5 } : { opacity: 0.5, margin: 2 },
  });
  const commits = both([square(1, false), square(2, true)]);
  assert.deepEqual(Object.keys(commits.at(-1).find((op) => op.op === "create").props.transition), ["x", "default"]);
});

test("random scenes update alike, patched or normalized in full", async () => {
  const sdk = await loadSdk(new URL("../dist/", import.meta.url));
  for (let seed = 1; seed <= 12; seed++) {
    const patched = await record(sdk, { seed, steps: 80, patch: true });
    const normalized = await record(sdk, { seed, steps: 80, patch: false });
    assert.deepEqual(patched.heard, normalized.heard, `seed ${seed}: handlers heard alike`);
    const index = patched.commits.findIndex((commit, at) => commit !== normalized.commits[at]);
    assert.equal(patched.commits.length, normalized.commits.length, `seed ${seed}: as many commits`);
    assert.equal(index, -1, `seed ${seed}, commit ${index}:\n${patched.commits[index]}\n${normalized.commits[index]}`);
  }
});
