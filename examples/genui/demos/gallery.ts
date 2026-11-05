// Every component the catalog has, in interfaces across the modes: a gallery
// for seeing how generated interfaces look, and a test of each mode.
//
//     node examples/genui/run.mjs examples/genui/demos/gallery.ts [floating|dock|canvas|dialog|all]

import { UIClient, type Spec } from "../client.js";

const which = process.argv[2] ?? "all";
const ui = new UIClient({ name: "Gallery" });

const showcase: Partial<Spec> = {
  root: "root",
  state: {
    tab: "Today", focus: true, volume: 0.6, note: "", done: [false, true],
    tasks: [{ id: "1", title: "Review the pull request", done: false }, { id: "2", title: "Book the train", done: true }],
  },
  elements: {
    root: { type: "Stack", props: { gap: "lg" }, children: ["head", "tabs", "today", "week"] },
    head: { type: "Stack", props: { direction: "horizontal", justify: "between" }, children: ["title", "badge"] },
    title: { type: "Heading", props: { text: "Thursday", level: 2 }, children: [] },
    badge: { type: "Badge", props: { text: "3 due", tone: "warning" }, children: [] },
    tabs: { type: "Tabs", props: { options: ["Today", "Week"], value: { $bindState: "/tab" } }, children: [] },
    today: { type: "Stack", props: { gap: "md" }, visible: { $state: "/tab", eq: "Today" },
             children: ["metrics", "tasks", "field", "switch", "slider", "actions"] },
    metrics: { type: "Grid", props: { columns: 2 }, children: ["m1", "m2"] },
    m1: { type: "Metric", props: { label: "Focus", value: "3h 20m", delta: "+40m", trend: "up" }, children: [] },
    m2: { type: "Metric", props: { label: "Meetings", value: 4, delta: "1 fewer", trend: "down" }, children: [] },
    tasks: { type: "List", props: {}, repeat: { statePath: "/tasks", key: "id" }, children: ["task"] },
    task: { type: "Checkbox", props: { label: { $item: "title" }, checked: { $bindItem: "done" } }, children: [] },
    field: { type: "TextField", props: { label: "Add a task", placeholder: "Something to do…", value: { $bindState: "/note" } },
             children: [], on: { submit: { action: "pushState", params: { statePath: "/tasks",
               value: { id: "$id", title: { $state: "/note" }, done: false }, clearStatePath: "/note" } } } },
    switch: { type: "Switch", props: { label: "Do not disturb", checked: { $bindState: "/focus" } }, children: [] },
    slider: { type: "Slider", props: { label: "Volume", value: { $bindState: "/volume" }, min: 0, max: 1, step: 0.05 }, children: [] },
    actions: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: ["primary", "secondary"] },
    primary: { type: "Button", props: { label: "Plan my day", variant: "filled" }, children: [],
               on: { press: { action: "plan", params: { tab: { $state: "/tab" } } } } },
    secondary: { type: "Button", props: { label: "Later", variant: "plain" }, children: [] },
    week: { type: "Stack", props: { gap: "md" }, visible: { $state: "/tab", eq: "Week" }, children: ["chart", "table"] },
    chart: { type: "BarChart", props: { data: [{ label: "Mon", value: 3.5 }, { label: "Tue", value: 5 },
      { label: "Wed", value: 2 }, { label: "Thu", value: 4.2 }, { label: "Fri", value: 1 }], unit: "h", orientation: "vertical", height: 90 },
             children: [] },
    table: { type: "Table", props: { columns: ["Project", "Hours"], rows: [["Proscenium", 12.5], ["Errands", 3]] }, children: [] },
  },
};

const reading: Partial<Spec> = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Release notes", subtitle: "v0.4 · generative UI" }, children: ["md", "code", "kv", "progress"] },
    md: { type: "Markdown", props: { text: "Interfaces are **json-render** specs, drawn natively:\n\n- no Wayland surface\n- no buffers to copy\n- `state` changes cost one small commit\n\n> Drag a card by its title bar." }, children: [] },
    code: { type: "Code", props: { text: "proscenium-ui ask \"Ship it?\" --choices Yes,No" }, children: [] },
    kv: { type: "KeyValue", props: { label: "Components", value: 27 }, children: [] },
    progress: { type: "ProgressBar", props: { label: "Rollout", value: 0.7, showValue: true, tone: "success" }, children: [] },
  },
};

const people: Partial<Spec> = {
  root: "list",
  elements: {
    list: { type: "List", props: {}, children: ["a", "b", "c"] },
    a: { type: "ListItem", props: { title: "Ada Lovelace", subtitle: "Reviewing your change", leading: "Ada Lovelace", trailing: "2m" }, children: [],
         on: { press: { action: "open", params: { who: "ada" } } } },
    b: { type: "ListItem", props: { title: "Build finished", subtitle: "All 214 tests passed", leading: "✅", trailing: "now" }, children: [] },
    c: { type: "ListItem", props: { title: "Lunch with Grace", subtitle: "12:30 at the usual place", leading: "🍜" }, children: [] },
  },
};

const question: Partial<Spec> = {
  root: "ask",
  elements: {
    ask: { type: "Stack", props: { gap: "lg" }, children: ["words", "buttons"] },
    words: { type: "Text", props: { text: "Restart the compositor to load the new build? Open windows are kept." }, children: [] },
    buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm", justify: "end" }, children: ["no", "yes"] },
    no: { type: "Button", props: { label: "Not now" }, children: [], on: { press: { action: "close" } } },
    yes: { type: "Button", props: { label: "Restart", variant: "filled" }, children: [], on: { press: { action: "restart" } } },
  },
};

if (which === "all" || which === "floating") void ui.open("showcase", { mode: "floating", place: { x: 380, y: 70 }, title: "Today", spec: showcase });
if (which === "all" || which === "dock") void ui.open("notes", { mode: "dock", place: { side: "left" }, title: "Release notes", spec: reading });
if (which === "all" || which === "canvas") void ui.open("people", { mode: "canvas", title: "Activity", spec: people });
if (which === "dialog") void ui.open("question", { mode: "dialog", title: "Restart?", spec: question });

ui.on("action", (event) => console.log(JSON.stringify(event)));
ui.on("placed", (event) => console.log(JSON.stringify(event)));
ui.on("closed", (event) => console.log(JSON.stringify(event)));
