// Reconciler host: what a React tree sends to the compositor.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { Background, Box, Group, Image, Mirror, Rect, Shortcut, Text, Window } from "../dist/components.js";
import { Session } from "../dist/session.js";
import { Container, createRoot, reconciler } from "../dist/host.js";
import { normalizeProps } from "../dist/props.js";
import { ease, spring, tween } from "../dist/motion.js";
import { backdropBlur, boxPaint, boxShadow, dimFilter, effectShader, filterShader, paintShader, planePaint } from "../dist/shader.js";
import { perspective, rotate, rotateY, scale } from "../dist/transform.js";

function mount(measure) {
  const commits = [];
  const container = new Container({ send: (ops) => commits.push(ops), measure });
  const root = createRoot(container, (error) => { throw error; });
  const render = (element) => {
    reconciler.updateContainerSync(element, root, null, null);
    reconciler.flushSyncWork();
    container.flush();
    return commits.at(-1);
  };
  return { container, commits, render };
}

test("a first commit resets the scene and sends canonical props", () => {
  const { render } = mount();
  const ops = render(h(Group, { x: 10, transform: [perspective(800), rotateY(90), scale(2)] },
    h(Rect, { width: 20, height: 10, fill: "#ff000080", shadow: { blur: 8, y: 2 },
              transition: { default: spring(), fill: { type: "instant" } },
              onPointerDown: () => {} })));
  assert.deepEqual(ops.map((op) => op.op),
                   ["shader", "shader", "reset", "create", "create", "insert", "insert"]);
  const [shadow, box, , group, rect] = ops;
  assert.deepEqual([shadow.id, box.id], [boxShadow.id, boxPaint.id],
                   "shaders are defined before the commit that uses them");
  assert.equal(group.type, "group");
  assert.equal(rect.type, "group", "a Rect is a group drawing a box");
  assert.deepEqual(group.props.transform,
    [["perspective", 800], ["rotate", 0, 1, 0, Math.PI / 2], ["scale", 2, 2, 1]]);
  const red = [1, 0, 0, 128 / 255], clear = [0, 0, 0, 0];
  assert.deepEqual(JSON.parse(JSON.stringify(rect.props.shaders)), [{
    id: "shadow", shader: boxShadow.id,
    uniforms: { color: clear, blur: 8, spread: 0, x: 0, y: 2 },
  }, {
    id: "box", shader: boxPaint.id,
    uniforms: { fill: red, fillEnd: red, fillAngle: 0, border: 0, outset: 0, borderColor: clear,
                borderColorEnd: clear, borderAngle: 0 },
    transition: { fill: { type: "instant" }, fillEnd: { type: "instant" }, fillAngle: { type: "instant" } },
  }], "the shadow comes first; uses without a motion of their own move with the node's default");
  assert.deepEqual(rect.props.handlers, ["pointerdown"]);
  assert.deepEqual(rect.props.transition, { default: spring() });
  assert.deepEqual(ops.slice(5), [
    { op: "insert", parent: group.id, id: rect.id, before: null },
    { op: "insert", parent: 0, id: group.id, before: null },
  ]);
});

test("updates send only changes, and removed props restore their defaults", () => {
  const { render } = mount();
  render(h(Window, { window: 7, x: 1, y: 2, radius: 4 }));
  const ops = render(h(Window, { window: 7, x: 5, y: 2 }));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "set");
  assert.deepEqual(ops[0].props, { x: 5, radius: null });
});

test("keyed reordering moves nodes without recreating them", () => {
  const { container, render } = mount();
  const rects = (keys) => h(Group, null, keys.map((key) => h(Rect, { key, width: key })));
  render(rects([1, 2, 3]));
  const ops = render(rects([3, 1, 2]));
  assert.ok(ops.length > 0 && ops.every((op) => op.op === "insert"));
  assert.deepEqual(container.children[0].children.map((rect) => rect.wire.width), [3, 1, 2]);
});

test("events reach the latest handler, and a reconnect replays the tree", () => {
  const { container, commits, render } = mount();
  const seen = [];
  render(h(Background, { onPointerDown: () => seen.push("old") }));
  const sent = commits.length;
  render(h(Background, { onPointerDown: (event) => seen.push(event.worldX) }));
  assert.equal(commits.length, sent, "a changed handler function is not a scene change");
  container.dispatch({ type: "event", node: 1, name: "pointerdown", "world-x": 42 });
  assert.deepEqual(seen, [42]);

  render(h(Shortcut, { keys: "Super+Shift+Enter", onPress: () => seen.push("press") }));
  container.dispatch({ type: "event", node: 1, name: "pointerdown", "world-x": 0 });
  assert.deepEqual(seen, [42], "removed nodes receive nothing");

  container.requestResync();
  container.flush();
  const [reset, create, insert] = commits.at(-1);
  assert.deepEqual(reset, { op: "reset" });
  assert.deepEqual(create, { op: "create", id: 2, type: "shortcut",
                             props: { key: "Return", modifiers: ["logo", "shift"], handlers: ["press"] } });
  assert.deepEqual(insert, { op: "insert", parent: 0, id: 2, before: null });
});

test("a Box lays out its children once their text is measured", () => {
  const requests = [];
  const { container, commits, render } = mount((batch) => requests.push(...batch));
  const layouts = [];
  render(h(Box, { x: 50, width: 200, style: [{ padding: 8 }, false, { gap: 4 }], alignItems: "center" },
    h(Text, { size: 12 }, "Hello"),
    h(Rect, { flexGrow: 1, height: 10, onLayout: (box) => layouts.push(box) }),
    h(Rect, { width: 20, height: 20, display: "none" })));
  assert.equal(commits.length, 0, "the commit waits for its text");
  assert.deepEqual(requests.map((request) => request.props), [{ text: "Hello", fontSize: 12 }]);

  container.receiveMeasurements([{ key: requests[0].key, width: 30, height: 16 }]);
  const [, box, text, , rect, , hidden] = commits[0];
  assert.deepEqual(box.props, { x: 50, width: 200, height: 32 });
  assert.deepEqual(text.props, { text: "Hello", fontSize: 12, x: 8, y: 8, width: 30 });
  assert.deepEqual(rect.props, { x: 42, y: 11, width: 150, height: 10 });
  assert.equal(hidden.props.visible, false);
  assert.deepEqual(layouts, [{ x: 42, y: 11, width: 150, height: 10 }]);
});

test("pointer events bubble, and enter and leave reach only the nodes crossed", () => {
  const { container, render } = mount();
  const seen = [];
  const handlers = (name, stop) => ({
    onPointerDown: (event) => {
      seen.push(`${name} down ${event.target.id}->${event.currentTarget.id}`);
      if (stop) event.stopPropagation();
    },
    onPointerEnter: (event) => seen.push(`${name} enter from ${event.relatedTarget?.id ?? "-"}`),
    onPointerLeave: () => seen.push(`${name} leave`),
  });
  render(h(Group, handlers("outer"),
    h(Rect, { width: 10, height: 10, ...handlers("inner", true) }, h(Rect, { width: 5, height: 5 })),
    h(Rect, { width: 10, height: 10 })));
  // Ids follow creation order: leaf 1, inner 2, sibling 3, outer 4.
  container.dispatch({ type: "event", node: 1, name: "pointerdown" });
  assert.deepEqual(seen.splice(0), ["inner down 1->2"]);
  container.dispatch({ type: "event", node: 3, name: "pointerdown" });
  assert.deepEqual(seen.splice(0), ["outer down 3->4"]);
  container.dispatch({ type: "event", node: 1, name: "pointerenter", from: null });
  assert.deepEqual(seen.splice(0), ["outer enter from -", "inner enter from -"]);
  container.dispatch({ type: "event", node: 1, name: "pointerleave", to: 3 });
  container.dispatch({ type: "event", node: 3, name: "pointerenter", from: 1 });
  assert.deepEqual(seen.splice(0), ["inner leave"]);
});

test("nested Texts style their part of the text as Pango markup", () => {
  const { render } = mount();
  const Count = ({ n }) => h(Text, { weight: "bold", color: "#ff8800" }, n);
  const [, text] = render(h(Text, { size: 14 }, "Saved ", h(Count, { n: 3 }), " files & <more>"));
  assert.deepEqual(text.props, {
    fontSize: 14, markup: true,
    text: 'Saved <span weight="700" foreground="#ff8800">3</span> files &amp; &lt;more&gt;',
  });
  const [update] = render(h(Text, { size: 14 }, "Saved ", h(Count, { n: 4 }), " files & <more>"));
  assert.match(update.props.text, />4</);
  const [plain] = render(h(Text, { size: 14 }, "Saved ", false, 4));
  assert.deepEqual(plain.props, { text: "Saved 4", markup: null });
});

test("keyframes, easing functions and effects reach the wire in canonical form", () => {
  const { render } = mount();
  const tint = effectShader({
    source: "vec4 effect(vec2 p) { return content(p) * tint; }",
    uniforms: { tint: 4, center: 2 }, extent: { pad: 4 }, reads: { local: true },
  });
  const tree = (n) => h(Group, {
    shaders: [{ id: "tint", shader: tint, uniforms: { tint: "#ff000080", center: [1, 2] } }],
    initial: { shaders: { tint: { center: [0, 0] } } },
    transition: { shaders: tween(0.5, ease.back()) },
  }, h(Rect, { width: n, animate: [{ transform: [rotate(0), rotate(90)], key: "spin" }, { x: (t) => t * 10, ease: ease.bounce }] }));
  const [define, , group, rect] = render(tree(10));
  assert.deepEqual(define, { op: "shader", id: tint.id, stage: "effect", source: tint.op.source,
                             uniforms: { tint: 4, center: 2 }, reads: { local: true }, extent: { pad: 4 } });
  const [use] = group.props.shaders;
  assert.deepEqual(use.uniforms, { tint: [1, 0, 0, 128 / 255], center: [1, 2] });
  assert.deepEqual(group.props.initial, { shaders: { tint: { center: [0, 0] } } });
  assert.equal(use.transition.type, "curve", "transition.shaders moves uses without their own");
  assert.equal(group.props.transition, undefined);
  const [spin, slide] = rect.props.animate;
  assert.deepEqual(spin, { property: "transform", keyframes: [[["rotate", 0, 0, 1, 0]], [["rotate", 0, 0, 1, Math.PI / 2]]],
                           duration: 0.5, id: "spin/transform" });
  assert.equal(slide.property, "x");
  assert.equal(slide.ease, undefined, "an easing function is baked into the keyframes");
  assert.equal(slide.keyframes.at(-1), 10);
  // The same animations keep their ids, so a re-render does not restart them.
  const [update] = render(tree(20));
  assert.deepEqual(update.props, { width: 20 });
});

test("shaders are defined once and their uses reach the wire with their motions", () => {
  const { container, commits, render } = mount();
  const definition = {
    source: "vec4 paint(vec2 p) { return tint * strength; }",
    uniforms: { tint: 4, strength: 1 },
    extent: { pad: 2, uniforms: { strength: [8, 8, 8, 8] } },
    gate: "strength",
  };
  const glow = paintShader(definition);
  assert.equal(paintShader({ ...definition }), glow, "equal definitions are one shader");
  const tree = (strength) => h(Rect, {
    width: 10, height: 10, shadow: { color: "#000", blur: 4 },
    shaders: [{ id: "glow", shader: glow, layer: "over", uniforms: { tint: "#00ff00", strength } }],
    transition: { shadow: tween(0.2), shaders: spring() },
    initial: { shadow: { blur: 0 }, shaders: { glow: { strength: 0 } } },
    exit: { shaders: { glow: { strength: 0 } } },
    animate: { shaders: { glow: { strength: [0, 1] } }, shadowBlur: [4, 8], key: "pulse" },
  });
  const ops = render(tree(1));
  const defines = ops.filter((op) => op.op === "shader");
  assert.deepEqual(defines.map((op) => op.id), [boxShadow.id, glow.id]);
  assert.deepEqual(defines[1].extent, { pad: 2, uniforms: { strength: [8, 8, 8, 8] } });
  assert.deepEqual(defines[1].gate, { uniform: "strength" });
  const rect = ops.find((op) => op.op === "create");
  const [shadow, paint] = rect.props.shaders;
  assert.equal(shadow.transition.type, "tween", "transition.shadow moves the shadow");
  assert.deepEqual(JSON.parse(JSON.stringify(paint)), { id: "glow", shader: glow.id, layer: "over",
                            uniforms: { tint: [0, 1, 0, 1], strength: 1 },
                            transition: { type: "spring", stiffness: 170, damping: 26, mass: 1 } });
  assert.deepEqual(rect.props.initial, { shaders: { shadow: { blur: 0 }, glow: { strength: 0 } } });
  assert.deepEqual(rect.props.exit, { shaders: { glow: { strength: 0 } } });
  assert.deepEqual(rect.props.animate.map((track) => track.property),
                   ["shaders.shadow.blur", "shaders.glow.strength"]);
  const [update] = render(tree(0.5));
  assert.equal(update.op, "set", "a known shader is not defined again");
  assert.equal(update.props.shaders[1].uniforms.strength, 0.5);
  container.requestResync();
  container.flush();
  assert.deepEqual(commits.at(-1).slice(0, 3).map((op) => op.op), ["shader", "shader", "reset"],
                   "a resync defines the shaders again");
});

test("decorations become standard shaders in the order they draw", () => {
  const { render } = mount();
  const ops = render(h(Group, null,
    h(Window, { window: 3, radius: 8, blur: 20, dim: 0.4,
                border: { width: 2, color: { from: "#fff", to: "#000", angle: 90 } },
                transition: { border: tween(0.3), borderAngle: { type: "instant" } },
                animate: { borderWidth: [2, 4], borderColor: ["#fff", "#f00"] } }),
    h(Image, { src: "/x.png", border: { width: 1, color: "#fff" } }),
    h(Background, { fill: "#123", grid: { kind: "lines", spacing: 40 }, exit: { fill: "#0000" } })));
  const [window, image, background] = ops.filter((op) => op.op === "create" && op.type !== "group");
  assert.deepEqual(window.props.shaders.map((use) => [use.id, use.shader]),
    [["box", boxPaint.id], ["blur", backdropBlur.id], ["dim", dimFilter.id]],
    "a frame's border goes before the blur inside it");
  const [frame] = window.props.shaders;
  assert.equal(frame.uniforms.outset, 2, "a window's border lies outside it");
  assert.equal(frame.uniforms.borderAngle, Math.PI / 2);
  assert.equal(frame.transition.border.type, "tween");
  assert.deepEqual(frame.transition.borderAngle, { type: "instant" });
  assert.deepEqual(window.props.animate.map((track) => track.property),
    ["shaders.box.border", "shaders.box.outset", "shaders.box.borderColor", "shaders.box.borderColorEnd"]);
  assert.deepEqual(image.props.shaders.map((use) => [use.id, use.layer]), [["box", "over"]],
                   "an image's border is drawn over it");
  const tint = filterShader({ source: "vec4 filter(vec4 color, vec2 p) { return color; }" });
  assert.throws(() => normalizeProps("window", { window: 4, dim: 0.5, shaders: [{ id: "tint", shader: tint }] }),
                /one filter/, "a window's dim is its one filter");
  assert.throws(() => normalizeProps("rect", { fill: "#fff", shaders: [{ id: "box", shader: boxShadow }] }),
                /share id "box"/, "decorations' ids are taken");
  const [plane] = background.props.shaders;
  assert.equal(plane.shader, planePaint.id);
  assert.deepEqual(plane.uniforms.lines, 1);
  assert.deepEqual(background.props.exit, { shaders: { plane: { color: [0, 0, 0, 0] } } });
});

test("mirrors draw a window again with its decorations", () => {
  const { render } = mount();
  const ops = render(h(Mirror, { window: 7, width: 160, height: 90, dim: 0.5,
                                 border: { width: 2, color: "#fff" } }));
  const mirror = ops.find((op) => op.op === "create" && op.type === "mirror");
  assert.deepEqual([mirror.props.window, mirror.props.width, mirror.props.height], [7, 160, 90]);
  assert.deepEqual(mirror.props.shaders.map((use) => use.id), ["box", "dim"],
                   "a mirror's border is a frame outside its box, and dim its filter");
  assert.equal(mirror.props.shaders[0].uniforms.outset, 2);
});

test("the latest keyboard grab hears keys until it lets go, and watchers hear input", () => {
  const session = new Session({ socket: "/nonexistent", onError: (error) => { throw error; } });
  try {
    const heard = [];
    const releaseFirst = session.grabKeyboard((event) => heard.push(`first ${event.key}`));
    const releaseSecond = session.grabKeyboard((event) => heard.push(`second ${event.key}`));
    const stopWatching = session.watchInput((event) => heard.push(`watch ${event.kind}`));
    const key = (name) => ({ type: "key", key: name, text: "", code: 1, pressed: true, repeat: false,
                             modifiers: [] });
    session.receive(key("a"));
    releaseSecond();
    session.receive(key("b"));
    session.receive({ type: "input", kind: "button", button: 272 });
    stopWatching();
    releaseFirst();
    session.receive(key("c"));
    session.receive({ type: "input", kind: "wheel" });
    assert.deepEqual(heard, ["second a", "first b", "watch button"]);
  } finally {
    session.stop();
  }
});

test("a spring may start at a velocity of its own", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(spring({ stiffness: 800, damping: 56, velocity: -1200 }))),
                   { type: "spring", stiffness: 800, damping: 56, mass: 1, velocity: -1200 });
  const { wire } = normalizeProps("group", { x: 3, transition: spring({ velocity: 40 }) });
  assert.equal(wire.transition.default.velocity, 40);
});
