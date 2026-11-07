// Random scenes updated at random, rendered into a Container: for checking that
// updates which skip normalizing send exactly what normalizing every update does.
//
// Every run with the same seed renders the same elements, so two runs differ only
// in how the container takes them. Props change in all the ways an update can:
// plain numbers, values a field drops ("50%" widths), new objects equal to the
// old ones, new handlers, layout props, `style`, decorations, shaders, motions,
// keys appearing, disappearing or reordering, Text content, nodes hidden as
// Suspense hides them, nodes mounting and unmounting.

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A copy of VALUE equal to it, sharing functions and frozen objects (shaders);
 * with REORDER, its objects list their keys the other way round.
 */
function clone(value, reorder = false) {
  if (Array.isArray(value)) return value.map((item) => clone(item, reorder));
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  const out = {};
  const keys = Object.keys(value);
  for (const key of reorder ? keys.reverse() : keys) out[key] = clone(value[key], reorder);
  return out;
}

/**
 * Renders STEPS random updates of the scene of SEED into a new Container made
 * with PATCH, firing events between them, and replaying the whole tree as after
 * a reconnect now and then. Returns each commit as JSON and what handlers heard.
 */
export async function record(sdk, { seed, steps, patch }) {
  const { React, Container, createRoot, reconciler } = sdk;
  const { Background, Box, Camera, Group, Image, Mirror, Rect, Shortcut, Text, Window } = sdk;
  const { instant, spring, tween, paintShader, perspective, rotate, rotateY } = sdk;
  const h = React.createElement;
  const rng = random(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const chance = (p) => rng() < p;

  const commits = [];
  const heard = [];
  const container = new Container({
    send: (ops) => commits.push(JSON.stringify(ops)),
    onError: (error) => { throw error; },
    patch,
  });
  const root = createRoot(container, (error) => { throw error; });
  const render = (element) => {
    reconciler.updateContainerSync(element, root, null, null);
    reconciler.flushSyncWork();
    container.flush();
  };

  const glow = paintShader({
    source: "vec4 paint(vec2 p) { return tint * strength; }", uniforms: { tint: 4, strength: 1 },
  });
  const sharedStyle = { opacity: 0.8, margin: 2 };
  const sharedAnimation = { x: [0, 4, 0], key: "nudge", duration: 0.4 };
  let functions = 0;
  const handler = (name) => {
    const id = functions++;
    return (event) => heard.push(`${name} #${id} on ${event.currentTarget?.id ?? event.x ?? "-"}`);
  };

  const number = () => pick([0, 5, 10.5, Math.round(rng() * 1000) / 10, -3]);
  const size = () => pick([10, 20, 32.5, "50%"]);
  const paint = () => pick(["#3478f6", "#ff375f80", [1, 0.5, 0, 1], { from: "#fff", to: "#000", angle: 90 },
                            { from: "#f00" }]);
  const transformValue = () => pick([[rotate(30)], [perspective(800), rotateY(number())], rotate(number())]);
  const common = {
    x: number, y: number, opacity: () => pick([0, 0.5, 1]), transform: transformValue,
    originX: () => pick([0, 0.5]), visible: () => pick([true, false]),
    transition: () => pick([instant, { default: spring() }, tween(0.2), { fill: instant, x: spring(), default: tween(0.1) },
                            { border: tween(0.3), borderAngle: instant, shaders: spring() }]),
    onPointerDown: () => handler("down"), onPointerEnter: () => handler("enter"),
    onDragEnd: () => handler("dragend"), onLayout: () => handler("layout"),
    draggable: () => pick([true, false]), cursor: () => pick(["pointer", "grab"]),
    style: () => pick([sharedStyle, { opacity: 0.5 }, [sharedStyle, { x: 3 }], [false, { margin: 4 }]]),
    margin: () => pick([0, 4, 8]), flexGrow: () => pick([0, 1]), display: () => pick(["flex", "none"]),
    minWidth: () => pick([0, 40]), alignSelf: () => pick(["center", "stretch"]),
    initial: () => ({ opacity: 0, x: number() }), exit: () => pick([{ opacity: 0 }, { shaders: { glow: { strength: 0 } } }]),
    animate: () => pick([sharedAnimation, { y: [0, number()], key: "bob" }, null]),
    layoutId: () => pick(["a", "b"]), ref: () => () => undefined, junk: () => number(),
  };
  const decorated = {
    ...common, width: size, height: size, radius: () => pick([0, 3, 8]), fill: paint,
    border: () => pick([{ width: 1, color: "#e5e5ea" }, { width: 2, color: paint() }, { color: "#fff" }]),
    shadow: () => pick([{ color: "#00000020", blur: 8, y: 2 }, { blur: 4 }]), blur: () => pick([0, 12]),
    shaders: () => pick([[{ id: "glow", shader: glow, uniforms: { tint: "#0f0", strength: rng() } }],
                         [{ id: "glow", shader: glow, layer: "over", uniforms: { tint: [0, 1, 0, 1], strength: 1 } }]]),
    clip: () => pick([true, false]),
  };
  const kinds = {
    rect: { component: Rect, props: decorated },
    group: { component: Group, props: { ...decorated, fill: undefined, border: undefined } },
    box: { component: Box, props: { ...decorated, padding: () => pick([0, 4]), gap: () => pick([0, 6]),
                                    flexDirection: () => pick(["row", "column"]) } },
    text: { component: Text, props: { ...common, width: size, size: () => pick([12, 14]), color: paint,
                                      weight: () => pick([400, "bold"]), font: () => "Inter", align: () => "center",
                                      lineHeight: () => 1.2, maxLines: () => pick([1, 2]), italic: () => true,
                                      text: () => pick(["Set", "Other"]), markup: () => pick([true, false]) } },
    image: { component: Image, props: { ...decorated, src: () => pick(["/a.png", "b.png"]), fit: () => "cover" } },
    window: { component: Window, props: { ...decorated, window: () => pick([7, 8]), dim: () => pick([0.3, 0.5]),
                                          movable: () => pick([true, false]), resizable: () => true,
                                          fill: undefined } },
    mirror: { component: Mirror, props: { ...decorated, window: () => 7, dim: () => 0.4, fill: undefined } },
    background: { component: Background, props: { fill: paint, grid: () => pick([{ kind: "lines", spacing: 40 }, { kind: "none" }]),
                                                   pan: () => true, onWheel: () => handler("wheel"), x: number,
                                                   transition: common.transition } },
    camera: { component: Camera, props: { x: number, y: number, zoom: () => pick([1, 2]), rotation: number } },
    shortcut: { component: Shortcut, props: { keys: () => pick(["Super+Return", "Ctrl+A"]),
                                              onPress: () => handler("press"), repeat: () => true } },
  };
  for (const kind of Object.values(kinds)) {
    for (const [key, make] of Object.entries(kind.props)) if (!make) delete kind.props[key];
  }

  let slots = 0;
  const slot = (type, children = []) => {
    const props = new Map([["x", 1], ["y", 2]]);
    const keys = Object.keys(kinds[type].props);
    for (let count = 0; count < 3; count++) {
      const key = pick(keys);
      props.set(key, kinds[type].props[key]());
    }
    return { id: slots++, type, props, children, present: true, generation: 0, content: "Hello" };
  };
  const leaf = () => slot(pick(["rect", "rect", "rect", "text", "text", "image", "window", "mirror", "group"]));
  const box = slot("box", [leaf(), leaf(), leaf(), slot("box", [leaf(), slot("text")]), leaf()]);
  const all = [
    slot("background"), slot("camera"), slot("shortcut"),
    slot("group", [leaf(), leaf(), leaf(), leaf(), slot("rect", [leaf()])]),
    box, leaf(), leaf(), leaf(), leaf(),
  ];

  const each = (list, visit) => {
    for (const item of list) {
      visit(item);
      each(item.children, visit);
    }
  };
  const mutate = (item) => {
    const makers = kinds[item.type].props;
    const keys = Object.keys(makers);
    if (chance(0.35)) {
      for (let count = 1 + Math.floor(rng() * 3); count > 0; count--) {
        const key = pick(keys);
        const before = item.props.get(key);
        const roll = rng();
        if (roll < 0.15) item.props.delete(key);
        else if (roll < 0.25) item.props.set(key, undefined);
        else if (roll < 0.4 && before !== undefined) item.props.set(key, clone(before, chance(0.3)));
        else item.props.set(key, makers[key]());
      }
    }
    // The animated case: x and y, nothing else.
    if (chance(0.5)) {
      item.props.set("x", number());
      item.props.set("y", number());
    }
    if (chance(0.04)) item.props = new Map([...item.props].sort(() => rng() - 0.5));
    if (item.type === "text" && chance(0.3)) {
      item.content = pick(["Hello", "World", 42, ["Count: ", Math.floor(rng() * 9)], "nested", "nested"]);
    }
    if (item.children.length === 0 && item.type !== "text" && chance(0.03)) item.present = !item.present;
    if (chance(0.02)) item.generation++;
  };
  const element = (item) => {
    if (!item.present) return null;
    const props = { key: `${item.id}/${item.generation}` };
    for (const [key, value] of item.props) props[key] = value;
    const { component } = kinds[item.type];
    if (item.type === "text") {
      const content = item.content === "nested"
        ? ["Saved ", h(Text, { key: "n", weight: "bold", color: "#f80" }, String(item.id)), " files"]
        : [item.content];
      return h(component, props, ...content);
    }
    return h(component, props, ...item.children.map(element));
  };
  const tree = () => h(React.Fragment, null, ...all.map(element));

  render(tree());
  for (let step = 0; step < steps; step++) {
    each(all, mutate);
    render(tree());
    // As Suspense hides and shows what it holds.
    if (chance(0.2)) {
      const nodes = [...container.instances.values()];
      const node = pick(nodes);
      container.setHidden(node, !node.hidden);
      container.flush();
    }
    for (let count = 0; count < 3; count++) {
      const node = 1 + Math.floor(rng() * container.nextId);
      const name = pick(["pointerdown", "pointerenter", "dragend", "wheel", "press"]);
      container.dispatch({ type: "event", node, name, x: 1, y: 2, from: null, to: null });
    }
    // Native drags settle in a microtask.
    await new Promise((resolve) => setImmediate(resolve));
    if (step % 9 === 8) {
      container.requestResync();
      container.flush();
    }
  }
  container.requestResync();
  container.flush();
  return { commits, heard };
}

/** What `record` needs, from the SDK's build at DIST (a URL ending in /). */
export async function loadSdk(dist) {
  const { createRequire } = await import("node:module");
  const React = await import(createRequire(new URL("host.js", dist)).resolve("react"));
  return {
    React: React.default ?? React,
    ...await import(new URL("index.js", dist)),
    ...await import(new URL("host.js", dist)),
  };
}
