// The UI kit's logic: placement of floating surfaces, keyboard movement, text fields,
// menus from JSX, portals into overlay layers, and controls whose states are data.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, Fragment, useState } from "react";
import { Box, Rect } from "../dist/components.js";
import { Container, createRoot, reconciler } from "../dist/host.js";
import { createPortal } from "../dist/index.js";
import { normalizeProps } from "../dist/props.js";
import { Session } from "../dist/session.js";
import { TextField } from "../dist/ui/TextField.js";
import { Button, Checkbox, sliderKey, Switch } from "../dist/ui/controls.js";
import { menuEntries, MenuItem, MenuLabel, MenuSeparator, Submenu } from "../dist/ui/Menu.js";
import { moveIndex, typeahead, TypeaheadBuffer } from "../dist/ui/navigation.js";
import { place } from "../dist/ui/placement.js";

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
  return { container, render, commits };
}

const screen = { x: 0, y: 0, width: 1000, height: 800 };
const menu = { width: 200, height: 300 };

test("a surface goes below its anchor, aligned to its start, growing from it", () => {
  const placed = place({ x: 100, y: 100, width: 80, height: 28 }, menu, screen, { gap: 4 });
  assert.deepEqual(placed, { x: 100, y: 132, side: "bottom", originX: 0.2, originY: 0 });
});

test("a surface flips above when only that side has room, and shifts in from the edge", () => {
  const placed = place({ x: 900, y: 700, width: 80, height: 28 }, menu, screen, { gap: 4, margin: 8 });
  assert.equal(placed.side, "top");
  assert.equal(placed.y, 700 - 4 - 300);
  // Shifted left so it ends at the margin.
  assert.equal(placed.x, 1000 - 8 - 200);
  assert.equal(placed.originY, 1);
});

test("with no room either side it takes the roomier and stays inside", () => {
  const placed = place({ x: 10, y: 350, width: 10, height: 10 }, { width: 100, height: 700 }, screen, { gap: 0 });
  assert.ok(placed.y >= 8 && placed.y + 700 <= 792, `y ${placed.y}`);
});

test("a menu at a point near the right edge opens to the left of it", () => {
  const point = { x: 950, y: 100, width: 0, height: 0 };
  const placed = place(point, menu, screen, { gap: 0, flipAlign: true });
  assert.equal(placed.x, 750);
  assert.equal(placed.originX, 1);
  const free = place({ ...point, x: 300 }, menu, screen, { gap: 0, flipAlign: true });
  assert.equal(free.x, 300);
});

test("a submenu goes right of its item, or left where the right has no room", () => {
  const item = { x: 580, y: 200, width: 200, height: 28 };
  assert.equal(place(item, menu, screen, { side: "right", gap: 0 }).x, 780);
  const wide = { ...item, x: 750 };
  const placed = place(wide, menu, screen, { side: "right", gap: 0 });
  assert.equal(placed.side, "left");
  assert.equal(placed.x, 550);
});

test("arrow keys, Home and End skip what takes no focus and wrap", () => {
  const enabled = [false, true, true, false, true];
  assert.equal(moveIndex("Down", -1, enabled), 1);
  assert.equal(moveIndex("Down", 2, enabled), 4);
  assert.equal(moveIndex("Down", 4, enabled), 1);
  assert.equal(moveIndex("Up", 1, enabled), 4);
  assert.equal(moveIndex("Up", -1, enabled), 4);
  assert.equal(moveIndex("Home", 4, enabled), 1);
  assert.equal(moveIndex("End", 1, enabled), 4);
  assert.equal(moveIndex("Down", 4, enabled, false), 4);
  assert.equal(moveIndex("a", 1, enabled), undefined);
});

test("typing picks an item by its start, and one letter again cycles", () => {
  const labels = ["Copy", "Cut", "Paste", "Close", "Delete"];
  const enabled = [true, true, true, true, false];
  assert.equal(typeahead("p", labels, enabled, -1), 2);
  assert.equal(typeahead("c", labels, enabled, -1), 0);
  assert.equal(typeahead("c", labels, enabled, 0), 1);
  assert.equal(typeahead("cc", labels, enabled, 1), 3);
  assert.equal(typeahead("cl", labels, enabled, 0), 3);
  assert.equal(typeahead("d", labels, enabled, 0), -1);
  const buffer = new TypeaheadBuffer(500);
  assert.equal(buffer.add("c", 0), "c");
  assert.equal(buffer.add("l", 100), "cl");
  assert.equal(buffer.add("p", 1000), "p");
});

const plain = (value) => JSON.parse(JSON.stringify(value));

test("an editable text's props and events reach the wire, chords and inset written out", () => {
  const { wire } = normalizeProps("text", {
    editable: true, multiline: true, readOnly: true, password: true, maxLength: 12, placeholder: "Search",
    placeholderColor: "#ff0000", caretColor: "#00ff00", selectionColor: "#0000ff80", valueRevision: 7,
    submitOnEnter: true, selectOnFocus: true, height: 40, contentInset: [4, 8, 4, 6],
    captureKeys: ["Up", "ctrl+Enter", "PageDown"],
    onInput: () => {}, onSubmit: () => {}, onSelect: () => {},
  });
  assert.equal(wire.editable, true);
  assert.equal(wire.multiline, true);
  assert.equal(wire.readOnly, true);
  assert.equal(wire.password, true);
  assert.equal(wire.maxLength, 12);
  assert.equal(wire.placeholder, "Search");
  assert.deepEqual(plain(wire.placeholderColor), [1, 0, 0, 1]);
  assert.deepEqual(plain(wire.caretColor), [0, 1, 0, 1]);
  assert.equal(wire.valueRevision, 7);
  assert.equal(wire.submitOnEnter, true);
  assert.equal(wire.selectOnFocus, true);
  assert.equal(wire.height, 40);
  assert.deepEqual(plain(wire.padding), [4, 8, 4, 6]);
  assert.equal(wire.captureKeys, "Up ctrl+Return Next");
  assert.deepEqual(wire.handlers, ["input", "select", "submit"]);
  assert.equal(normalizeProps("text", { contentInset: 3 }).wire.padding, 3);
  assert.equal(normalizeProps("text", { keymap: "standard" }).wire.keymap, "standard");
});

/** The props the latest commit created or set on the editable text node. */
function editable(commits) {
  for (let i = commits.length - 1; i >= 0; i--) {
    for (const op of [...commits[i]].reverse()) {
      if ((op.op === "create" && op.props.editable) || (op.op === "set" && op.props.text !== undefined)) {
        return { id: op.id, props: op.props };
      }
    }
  }
  return null;
}

/** A session that never connects: the kit's hooks read its stores. */
function withSession(body) {
  const session = new Session({ socket: "/nonexistent/proscenium.sock", onError: (error) => { throw error; } });
  try {
    body();
  } finally {
    session.stop();
  }
}

test("a TextField declares its value with the revision of the latest input it heard", () => withSession(() => {
  const { container, render, commits } = mount();
  let typed = [];
  function Field() {
    const [value, setValue] = useState("hi");
    return h(TextField, { value, onChangeText: (text) => { typed.push(text); setValue(text); } });
  }
  render(h(Field));
  const created = editable(commits);
  assert.equal(created.props.text, "hi");
  assert.equal(created.props.valueRevision, 0);
  assert.equal(created.props.tabIndex, 0);
  assert.equal(created.props.keymap, "emacs", "the theme's keymap, Emacs by default");
  assert.deepEqual(plain(created.props.padding), [1, 9, 1, 9]);
  // The compositor reports two keystrokes at once: the field echoes the newest, with its revision.
  for (const [text, revision] of [["hix", 1], ["hixy", 2]]) {
    container.dispatch({ type: "event", node: created.id, name: "input", text, revision, "selection-start": text.length,
                         "selection-end": text.length, "selection-direction": "forward" });
  }
  reconciler.flushSyncWork();
  container.flush();
  assert.deepEqual(typed, ["hix", "hixy"]);
  const echoed = editable(commits);
  assert.equal(echoed.props.text, "hixy");
  assert.equal(echoed.props.valueRevision, 2);
}));

test("a TextField with onKey and no captureKeys leaves list keys to the world", () => withSession(() => {
  const { render, commits } = mount();
  render(h(TextField, { value: "", onKey: () => true }));
  assert.equal(editable(commits).props.captureKeys, "Up Down Prior Next Escape");
  const other = mount();
  other.render(h(TextField, { value: "", multiline: true, onSubmit: () => {}, onKey: () => true }));
  const multiline = editable(other.commits).props;
  assert.equal(multiline.captureKeys, "Escape");
  assert.equal(multiline.submitOnEnter, true);
  assert.equal(multiline.multiline, true);
}));

test("slider keys step, take bigger steps and stop at the ends", () => {
  assert.equal(sliderKey("Right", 0.5, 0, 1), 0.51);
  assert.equal(sliderKey("Left", 0.5, 0, 1, undefined, true), 0.4);
  assert.equal(sliderKey("Up", 4, 0, 10, 1), 5);
  assert.equal(sliderKey("Page_Up", 4, 0, 100, 5), 15);
  assert.equal(sliderKey("End", 4, 0, 10), 10);
  assert.equal(sliderKey("Left", 0, 0, 10, 1), 0);
  assert.equal(sliderKey("a", 0, 0, 10), undefined);
});

test("menu entries come from lists and from JSX alike", () => {
  const fromJsx = menuEntries(h(Fragment, null,
    h(MenuLabel, { label: "Edit" }),
    h(MenuItem, { label: "Copy", shortcut: "Ctrl+C" }),
    false,
    h(MenuSeparator),
    h(Submenu, { label: "More" }, h(MenuItem, { label: "Deeper" }))));
  assert.deepEqual(fromJsx.map((entry) => entry.type), ["label", "item", "separator", "submenu"]);
  assert.equal(fromJsx[1].shortcut, "Ctrl+C");
  assert.equal(fromJsx[3].items[0].label, "Deeper");
  const fromList = menuEntries([{ label: "A" }, "-", null, { type: "submenu", label: "B", items: [{ label: "C" }] }]);
  assert.deepEqual(fromList.map((entry) => entry.type), ["item", "separator", "submenu"]);
  assert.equal(fromList[2].items[0].label, "C");
});

test("a portal renders into a node elsewhere in the tree", () => {
  const { render } = mount();
  let layer = null;
  function World() {
    const [target, setTarget] = useState(null);
    return h(Fragment, null,
      h(Box, { width: 10, height: 10 }, target && createPortal(h(Rect, { width: 4, height: 4, fill: "#ff0000" }), target)),
      h(Rect, { ref: (node) => { layer = node; if (node && node !== target) setTarget(node); } }));
  }
  render(h(World));
  const ops = render(h(World));
  const rect = ops.find((op) => op.op === "create" && op.props.width === 4);
  assert.ok(rect, "the portal's child is created");
  const inserted = ops.find((op) => op.op === "insert" && op.id === rect.id);
  assert.equal(inserted.parent, layer.id);
});

test("messages naming nodes wait until what is committed has been sent", async () => {
  const sent = [];
  const container = new Container({ send: (ops) => { sent.push("commit"); } });
  const root = createRoot(container, (error) => { throw error; });
  reconciler.updateContainerSync(h(Rect, { width: 1 }), root, null, null);
  reconciler.flushSyncWork();
  container.afterCommitted(() => sent.push("focus"));
  assert.deepEqual(sent, []);
  container.flush();
  assert.deepEqual(sent, ["commit", "focus"]);
  // With nothing left to send, at once.
  await Promise.resolve();
  container.afterCommitted(() => sent.push("now"));
  assert.deepEqual(sent, ["commit", "focus", "now"]);
});

test("controls show hover, press and focus as states, not as renders", () => {
  const { render } = mount();
  let renders = 0;
  function Counted() {
    renders++;
    return h(Box, null, h(Button, { label: "Save", variant: "filled" }), h(Switch, { value: true }),
             h(Checkbox, { value: false, label: "Done" }));
  }
  const ops = render(h(Counted));
  const creates = ops.filter((op) => op.op === "create");
  const button = creates.find((op) => op.props.tabIndex === 0 && op.props.states?.hover && op.props.height === 28);
  assert.ok(button, "the button is focusable and has a hover state");
  assert.ok(button.props.states.pressed && button.props.states.focusVisible, "pressed and focus-visible states");
  assert.equal(button.props.stateGroup, true);
  assert.equal(renders, 1);
  // Group states on the checkbox's box follow the row.
  assert.ok(creates.some((op) => op.props.states?.group === true));
});
