// Controls the compositor serves itself: states, clicks, focus, keys and scroll containers.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { Box, Rect, Text } from "../dist/components.js";
import { Container, createRoot, reconciler } from "../dist/host.js";
import { normalizeProps } from "../dist/props.js";
import { boxPaint } from "../dist/shader.js";
import { scale } from "../dist/transform.js";
import { Pressable } from "../dist/ui/Pressable.js";

function mount() {
  const commits = [];
  const container = new Container({ send: (ops) => commits.push(ops) });
  const root = createRoot(container, (error) => { throw error; });
  const render = (element) => {
    reconciler.updateContainerSync(element, root, null, null);
    reconciler.flushSyncWork();
    container.flush();
    return commits.at(-1);
  };
  return { container, render };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("states reach the wire as initial and exit values do", () => {
  const { wire } = normalizeProps("rect", {
    fill: "#000000", opacity: 0.8,
    states: { hover: { fill: "#ff0000", opacity: 1 }, pressed: { transform: [scale(0.9)] }, group: true },
  });
  const red = [1, 0, 0, 1];
  assert.deepEqual(plain(wire.states), {
    hover: { opacity: 1, shaders: { box: { fill: red, fillEnd: red } } },
    pressed: { transform: [["scale", 0.9, 0.9, 1]] },
    group: true,
  });
  const text = normalizeProps("text", { states: { focusVisible: { color: "#00ff00" } } }).wire;
  assert.deepEqual(plain(text.states), { focusVisible: { color: [0, 1, 0, 1] } });
});

test("a decoration only states name is added transparent for them to change", () => {
  const { wire } = normalizeProps("box", { states: { hover: { fill: "#ffffff" } } });
  assert.equal(wire.shaders.length, 1);
  assert.equal(wire.shaders[0].shader, boxPaint.id);
  assert.deepEqual(plain(wire.shaders[0].uniforms.fill), [0, 0, 0, 0]);
});

test("control props and handlers reach the wire", () => {
  const { wire } = normalizeProps("box", {
    stateGroup: true, tabIndex: 0, focusScope: true, scroll: "y", stickToEnd: true, overscroll: "contain",
    onClick: () => {}, onDoubleClick: () => {}, onAuxClick: () => {}, onContextMenu: () => {},
    onFocus: () => {}, onBlur: () => {}, onKeyDown: () => {}, onKeyUp: () => {}, onScroll: () => {},
  });
  assert.equal(wire.stateGroup, true);
  assert.equal(wire.tabIndex, 0);
  assert.equal(wire.focusScope, true);
  assert.equal(wire.scroll, "y");
  assert.equal(wire.stickToEnd, true);
  assert.equal(wire.overscroll, "contain");
  assert.deepEqual(wire.handlers, ["auxclick", "blur", "click", "contextmenu", "dblclick", "focus", "keydown",
                                   "keyup", "scroll"]);
  assert.equal(normalizeProps("rect", { scrollThumb: "y" }).wire.scrollThumb, "y");
});

test("clicks, menus and keys bubble; focus and scroll do not", () => {
  const { container, render } = mount();
  const seen = [];
  render(h(Box, { onClick: (event) => seen.push(`click ${event.count}`), onKeyDown: (event) => seen.push(event.key),
                  onContextMenu: () => seen.push("menu"), onFocus: () => seen.push("outer focus"),
                  onScroll: () => seen.push("outer scroll") },
    h(Rect, { width: 10, height: 10, tabIndex: 0, onFocus: (event) => seen.push(`focus ${event.visible}`) })));
  // Ids follow creation order: the rect 1, the box 2.
  container.dispatch({ type: "event", node: 1, name: "click", button: 272, count: 2 });
  container.dispatch({ type: "event", node: 1, name: "contextmenu", button: 273 });
  container.dispatch({ type: "event", node: 1, name: "keydown", key: "Tab", text: "", code: 15, repeat: false,
                       modifiers: [] });
  container.dispatch({ type: "event", node: 1, name: "focus", visible: true });
  container.dispatch({ type: "event", node: 1, name: "scroll", "scroll-x": 0, "scroll-y": 4 });
  assert.deepEqual(seen, ["click 2", "menu", "Tab", "focus true"]);
});

test("a scrolling Box sends how far its content reaches", () => {
  const { render } = mount();
  const ops = render(h(Box, { width: 100, height: 50, scroll: "y", paddingBottom: 4 },
    h(Box, { position: "absolute", x: 0, y: 0, width: "100%", flexDirection: "column" },
      h(Rect, { height: 40 }), h(Rect, { height: 40 }))));
  const scroller = ops.find((op) => op.op === "create" && op.props.scroll === "y");
  assert.deepEqual([scroller.props.contentWidth, scroller.props.contentHeight], [100, 84]);
  const more = render(h(Box, { width: 100, height: 50, scroll: "y", paddingBottom: 4 },
    h(Box, { position: "absolute", x: 0, y: 0, width: "100%", flexDirection: "column" },
      h(Rect, { height: 40 }), h(Rect, { height: 40 }), h(Rect, { height: 40 }))));
  const set = more.find((op) => op.op === "set" && op.id === scroller.id);
  assert.deepEqual(set.props, { contentHeight: 124 }, "content growing in a box that stays sends its extent");
});

test("a Pressable's looks by state go to the compositor, its press to onClick", () => {
  const { container, render } = mount();
  let pressed = 0;
  const ops = render(h(Pressable, { onPress: () => pressed++, width: 80, height: 30,
                                    states: { hover: { opacity: 0.5 } } }, h(Text, { states: { group: true } }, "Go")));
  const box = ops.find((op) => op.op === "create" && op.props.stateGroup);
  assert.equal(box.props.tabIndex, 0);
  assert.deepEqual(plain(box.props.states), { hover: { opacity: 0.5 } });
  assert.deepEqual(box.props.handlers, ["click"], "it renders nothing as the pointer comes and goes");
  container.dispatch({ type: "event", node: box.id, name: "click", button: 272, count: 1 });
  assert.equal(pressed, 1);
  const disabled = render(h(Pressable, { onPress: () => pressed++, disabled: true, width: 80, height: 30,
                                         states: { hover: { opacity: 0.5 } } }, h(Text, null, "Go")));
  const update = disabled.find((op) => op.op === "set" && op.id === box.id);
  assert.equal(update.props.states, null);
  assert.equal(update.props.tabIndex, null);
});
