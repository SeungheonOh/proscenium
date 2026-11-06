import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogPrompt, componentNames, markdownBlocks, Surface } from "../dist/genui/index.js";

test("a surface builds its spec from streamed patches, state apart", () => {
  const surface = new Surface();
  let specChanges = 0;
  let stateChanges = 0;
  surface.subscribe(() => specChanges++);
  surface.state.subscribe(() => stateChanges++);
  const problems = surface.apply([
    { op: "add", path: "/root", value: "card" },
    { op: "add", path: "/elements/card", value: { type: "Card", props: { title: "Hi" }, children: ["list"] } },
    { op: "add", path: "/elements/list", value: { type: "List", props: {}, repeat: { statePath: "/items" } } },
    { op: "add", path: "/state/items", value: [] },
    { op: "add", path: "/state/items/0", value: { id: "1" } },
    { op: "add", path: "/state/items/-", value: { id: "2" } },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(specChanges, 1, "one spec change for the whole batch");
  assert.equal(stateChanges, 3, "one state change per state patch");
  assert.equal(surface.spec.root, "card");
  assert.deepEqual(surface.spec.elements.list.children, [], "children default to a list");
  assert.deepEqual(surface.state.get("/items"), [{ id: "1" }, { id: "2" }]);
  assert.deepEqual(surface.toJSON().state, { items: [{ id: "1" }, { id: "2" }] });
});

test("a patch inside an element replaces only that element", () => {
  const surface = new Surface({ root: "a", elements: {
    a: { type: "Stack", props: {}, children: ["b"] }, b: { type: "Text", props: { text: "old" }, children: [] } } });
  const before = surface.spec.elements;
  surface.apply([{ op: "replace", path: "/elements/b/props/text", value: "new" }]);
  assert.equal(surface.spec.elements.b.props.text, "new");
  assert.equal(before.b.props.text, "old", "the old spec is left as it was");
  assert.equal(surface.spec.elements.a, before.a, "untouched elements keep their objects");
});

test("bad patches are reported and the rest still apply", () => {
  const surface = new Surface();
  const problems = surface.apply([
    { op: "add", path: "/nowhere", value: 1 },
    { op: "replace", path: "/elements/missing/props/x", value: 1 },
    { op: "add", path: "/root", value: "r" },
  ]);
  assert.equal(problems.length, 2);
  assert.equal(surface.spec.root, "r");
});

test("a surface names what is wrong with its spec", () => {
  const surface = new Surface({ root: "a", elements: {
    a: { type: "Stack", props: { on: {} }, children: ["b", "c"] }, b: { type: "Gizmo", props: {}, children: [] } } });
  const problems = surface.problems(componentNames);
  assert.ok(problems.some((problem) => problem.includes('"c", which does not exist')));
  assert.ok(problems.some((problem) => problem.includes('unknown type "Gizmo"')));
  assert.ok(problems.some((problem) => problem.includes('"on" inside props')));
});

test("state updates replace the whole state at the root pointer", () => {
  const surface = new Surface();
  surface.state.update({ "/a": 1 });
  surface.state.update({ "": { b: 2 }, "/c": 3 });
  assert.deepEqual(surface.state.getSnapshot(), { b: 2, c: 3 });
});

test("markdown becomes blocks of Pango markup", () => {
  const blocks = markdownBlocks("# Title\n\nSome **bold** and `a<b`.\n\n- one\n- [x] two\n\n```\ncode <here>\n```");
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "list", "code"]);
  assert.match(blocks[1].markup, /<b>bold<\/b>/);
  assert.match(blocks[1].markup, /a&lt;b/, "code is escaped");
  assert.deepEqual(blocks[2].items.map((item) => item.marker), ["•", "☑"]);
  assert.equal(blocks[3].text, "code <here>", "code blocks stay plain text");
});

test("the catalog prompt teaches the tool's patch list and every component", () => {
  const prompt = catalogPrompt("ui_render");
  assert.match(prompt, /`patches` list of the ui_render tool/);
  assert.doesNotMatch(prompt, /Output ONLY JSONL/);
  for (const name of componentNames) assert.match(prompt, new RegExp(`- ${name}:`), name);
});

test("a value read from state that is not there is a problem, until it is set", () => {
  const surface = new Surface({ root: "a", state: { running: false }, elements: {
    a: { type: "Stack", props: {}, children: ["clock", "toggle", "field"] },
    clock: { type: "Text", props: { text: { $state: "/clock" } }, children: [] },
    toggle: { type: "Button", props: { label: { $cond: { $state: "/paused" }, $then: "Resume", $else: { $state: "/verb" } } },
              children: [] },
    field: { type: "TextField", props: { value: { $bindState: "/name" } }, children: [] } } });
  const reads = surface.problems(componentNames).filter((problem) => problem.includes("its state does not have"));
  assert.deepEqual(reads.map((problem) => problem.split(" ")[1]), ['"clock"', '"toggle"'],
                   "a $cond's condition and an input's binding may be unset; shown values may not");
  surface.state.update({ "/clock": "25:00", "/verb": "Start" });
  assert.equal(surface.problems(componentNames).filter((problem) => problem.includes("its state does not have")).length, 0);
});
