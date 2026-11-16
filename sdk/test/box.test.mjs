// The box and text vocabulary: corners, borders by side, shadow lists, gradients, text features.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProps } from "../dist/props.js";
import { boxInsetShadow, boxPaint, boxPaintWith, boxShadow, boxShadowWith,
  gradientPaint } from "../dist/shader.js";

const uses = (props, type = "rect") => normalizeProps(type, props).wire.shaders ?? [];
const use = (props, id, type) => uses(props, type).find((shading) => shading.id === id);

test("a radius is one number or four corners on the wire", () => {
  assert.equal(normalizeProps("rect", { radius: 8 }).wire.radius, 8);
  assert.deepEqual(normalizeProps("rect", { radius: [8, 8, 0, 0] }).wire.radius, [8, 8, 0, 0]);
  assert.deepEqual(normalizeProps("rect", { initial: { radius: [0, 4, 0, 4] } }).wire.initial.radius, [0, 4, 0, 4]);
  const track = normalizeProps("rect", { animate: { radius: [4, [8, 8, 0, 0]], duration: 1 } }).wire.animate[0];
  assert.deepEqual(track.keyframes, [[4, 4, 4, 4], [8, 8, 0, 0]], "keyframes are four corners each");
});

test("border widths by side become the widest and what each side lacks", () => {
  const box = use({ border: { width: [0, 0, 1, 0], color: "#000" } }, "box");
  assert.equal(box.shader, boxPaintWith({ sides: true }).id, "a box with sides has a program of its own");
  assert.equal(box.uniforms.border, 1);
  // Left, top, right, bottom: only the bottom keeps its width.
  assert.deepEqual(box.uniforms.borderTrim, [1, 1, 1, 0]);
  assert.equal(box.uniforms.dash, undefined);
  const plain = use({ fill: "#fff", border: { width: 1 }, radius: 4 }, "box");
  assert.equal(plain.shader, boxPaint.id, "a plain box draws with the plain program");
  assert.equal(plain.uniforms.borderTrim, undefined);
  const cornered = uses({ fill: "#fff", radius: [8, 8, 0, 0], shadow: { blur: 4 } });
  assert.deepEqual(cornered.map((shading) => shading.shader),
                   [boxShadowWith({ corners: true }).id, boxPaintWith({ corners: true }).id]);
  assert.equal(use({ fill: "#fff", radius: [4, 4, 4, 4] }, "box").shader, boxPaint.id,
               "four equal corners are one radius");
  assert.equal(use({ border: { width: 2, dash: true } }, "box").uniforms.dash, 6);
  assert.equal(use({ border: { width: 2, dash: 4 } }, "box").uniforms.dash, 4);
  const frame = use({ border: { width: [1, 2, 3, 4] } }, "box", "window");
  assert.equal(frame.uniforms.outset, 4, "a frame lies outside by its widest side");
});

test("shadows are a list, the first on top, insets over the fill", () => {
  const ambient = { color: "#0002", blur: 2, y: 1 }, key = { color: "#0004", blur: 16, y: 8, spread: -4 };
  const ids = uses({ fill: "#fff", shadow: [ambient, key, { color: "#0003", blur: 4, inset: true }] })
    .map((shading) => [shading.id, shading.shader]);
  assert.deepEqual(ids, [["shadow2", boxShadow.id], ["shadow", boxShadow.id], ["box", boxPaint.id],
                         ["insetShadow", boxInsetShadow.id]]);
  assert.equal(use({ shadow: key }, "shadow").uniforms.spread, -4, "one shadow keeps its id");
  const exit = normalizeProps("rect", { shadow: [ambient, key], exit: { shadow: [{ blur: 0 }, { y: 0 }] } }).wire.exit;
  assert.deepEqual(exit.shaders, { shadow: { blur: 0 }, shadow2: { y: 0 } });
});

test("a gradient of stops is an Oklab paint under the border", () => {
  const all = uses({ fill: { stops: ["#000", ["#fff", 0.25], "#f00", "#00f"], angle: 90 },
                     border: { width: 1, color: "#000" } });
  assert.deepEqual(all.map((shading) => shading.id), ["gradient", "box"]);
  const gradient = all[0];
  assert.equal(gradient.shader, gradientPaint.id);
  assert.deepEqual(gradient.uniforms.stops, [0, 0.25, 0.625, 1], "stops without places spread evenly");
  const white = gradient.uniforms.color1;
  assert.ok(Math.abs(white[0] - 1) < 1e-6 && Math.abs(white[1]) < 1e-6 && Math.abs(white[2]) < 1e-6,
            "white is L 1, a 0, b 0");
  assert.equal(gradient.uniforms.angle, Math.PI / 2);
  assert.deepEqual(all[1].uniforms.fill, [0, 0, 0, 0], "the box paint draws only the border");
  const two = use({ fill: { stops: ["#f00", "#00f"] } }, "gradient");
  assert.deepEqual(two.uniforms.stops, [0, 1, 1, 1], "fewer stops repeat the last");
  assert.deepEqual(two.uniforms.color3, two.uniforms.color1);
  assert.throws(() => uses({ fill: { stops: ["#000", "#111", "#222", "#333", "#444"] } }), /at most 4/);
});

test("text features, letter spacing and decoration reach the wire", () => {
  const wire = normalizeProps("text", {
    text: "12:00", letterSpacing: 0.5, tabularNumbers: true, features: { liga: false },
    decoration: "underline",
  }).wire;
  assert.equal(wire.letterSpacing, 0.5);
  assert.equal(wire.fontFeatures, '"tnum" 1, "liga" 0');
  assert.equal(wire.decoration, "underline");
  assert.equal(normalizeProps("rect", { groupOpacity: true }).wire.groupOpacity, true);
});
