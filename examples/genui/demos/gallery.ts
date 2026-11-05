// Every component the catalog has, in interfaces across the modes: a gallery
// for seeing how generated interfaces look, and a test of each mode.
//
//     node examples/genui/run.mjs examples/genui/demos/gallery.ts [floating|parts|dock|canvas|dialog|all]

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

const parts: Partial<Spec> = {
  root: "root",
  elements: {
    root: { type: "Stack", props: { gap: "lg" }, children: ["h1", "h2", "h3", "texts", "badges", "people", "inner", "tinted", "ink", "bars", "spark", "busy", "count"] },
    h1: { type: "Heading", props: { text: "Heading one", level: 1 }, children: [] },
    h2: { type: "Heading", props: { text: "Heading two", level: 2 }, children: [] },
    h3: { type: "Heading", props: { text: "Heading three", level: 3 }, children: [] },
    texts: { type: "Stack", props: { gap: "xs" }, children: ["t1", "t2", "t3", "t4"] },
    t1: { type: "Text", props: { text: "Body text that wraps onto a second line when the card is narrow enough." }, children: [] },
    t2: { type: "Text", props: { text: "Muted, small", tone: "muted", size: "sm" }, children: [] },
    t3: { type: "Text", props: { text: "Large and bold, in the accent", tone: "accent", size: "lg", weight: "bold" }, children: [] },
    t4: { type: "Text", props: { text: "mono 12:04:59", mono: true }, children: [] },
    badges: { type: "Stack", props: { direction: "horizontal", gap: "sm", wrap: true }, children: ["b1", "b2", "b3", "b4", "b5"] },
    b1: { type: "Badge", props: { text: "Default" }, children: [] },
    b2: { type: "Badge", props: { text: "Success", tone: "success" }, children: [] },
    b3: { type: "Badge", props: { text: "Warning", tone: "warning" }, children: [] },
    b4: { type: "Badge", props: { text: "Danger", tone: "danger" }, children: [] },
    b5: { type: "Badge", props: { text: 12, tone: "muted" }, children: [] },
    people: { type: "Stack", props: { direction: "horizontal", gap: "md" }, children: ["av1", "av2", "who", "spacer", "when"] },
    av1: { type: "Avatar", props: { name: "Ada Lovelace" }, children: [] },
    av2: { type: "Avatar", props: { name: "Grace Hopper", size: 28 }, children: [] },
    who: { type: "Text", props: { text: "Ada and Grace" }, children: [] },
    spacer: { type: "Spacer", props: {}, children: [] },
    when: { type: "Text", props: { text: "2m", tone: "muted", size: "sm" }, children: [] },
    inner: { type: "Card", props: { title: "A card in a card", subtitle: "With a subtitle" }, children: ["kv1", "kv2"] },
    kv1: { type: "KeyValue", props: { label: "Plan", value: "Pro" }, children: [] },
    kv2: { type: "KeyValue", props: { label: "Renews", value: "Dec 1", tone: "warning" }, children: [] },
    tinted: { type: "Card", props: { title: "Tinted", variant: "tinted" }, children: ["tintedText"] },
    tintedText: { type: "Text", props: { text: "A soft accent behind it." }, children: [] },
    ink: { type: "Card", props: { title: "Ink", variant: "ink" }, children: ["inkText", "inkDivider", "inkButton"] },
    inkText: { type: "Text", props: { text: "Light text on a dark card." }, children: [] },
    inkDivider: { type: "Divider", props: {}, children: [] },
    inkButton: { type: "Button", props: { label: "On ink", variant: "tinted", size: "small" }, children: [] },
    bars: { type: "BarChart", props: { data: [{ label: "Mail", value: 42 }, { label: "Chat", value: 18.5 }, { label: "Docs", value: 7 }], unit: "min" }, children: [] },
    spark: { type: "Stack", props: { direction: "horizontal", gap: "md", align: "end" }, children: ["sparkValue", "sparkline"] },
    sparkValue: { type: "Metric", props: { label: "Requests", value: "1.2k", unit: "/s" }, children: [] },
    sparkline: { type: "Sparkline", props: { values: [3, 5, 4, 8, 6, 9, 7, 12, 10, 14], height: 36 }, children: [] },
    busy: { type: "ProgressBar", props: { value: null, label: "Indexing…" }, children: [] },
    count: { type: "Countdown", props: { seconds: 90, running: false, size: "md" }, children: [] },
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
if (which === "all" || which === "parts") void ui.open("parts", { mode: "floating", place: { x: 760, y: 60 }, title: "Parts", width: 340, spec: parts });
if (which === "dialog") void ui.open("question", { mode: "dialog", title: "Restart?", spec: question });

ui.on("action", (event) => console.log(JSON.stringify(event)));
ui.on("placed", (event) => console.log(JSON.stringify(event)));
ui.on("closed", (event) => console.log(JSON.stringify(event)));
