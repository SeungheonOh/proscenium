// To-do: a list that keeps. Add with the field, tick off, clear what is done;
// it is saved as it changes and is back after a restart. Other programs add to
// it as well, by telling it:
//
//     proscenium-ui start todo
//     proscenium-ui tell todo '"Water the plants"'
//     proscenium-ui tell todo '{"text": "Renew the passport"}'

import { app, type View } from "proscenium-app";

interface Item {
  id: string;
  title: string;
  /** When it was ticked off, in ms; null while it is still to do. */
  doneAt: number | null;
}

const ui = app({ name: "todo", title: "To-do" });
let items = ui.load<Item[]>([]);
let view: View | undefined;
/** The last id given: ids grow, so the list keeps its order across restarts. */
let lastId = items.reduce((most, item) => Math.max(most, Number(item.id) || 0), 0);

const today = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

/** The list as the card shows it: what is left in the order added, what is done latest first. */
function shown(): Record<string, unknown> {
  const open = items.filter((item) => item.doneAt === null);
  const done = items.filter((item) => item.doneAt !== null).sort((a, b) => b.doneAt! - a.doneAt!);
  return {
    day: today(),
    left: open.length ? `${open.length} to do` : "all done",
    leftTone: open.length ? "accent" : "success",
    open: open.map((item) => ({ id: item.id, title: item.title, done: false })),
    done: done.map((item) => ({ id: item.id, title: item.title, done: true })),
    noneOpen: open.length === 0,
    noneDone: done.length === 0,
    hasDone: done.length > 0,
  };
}

function settle(next: Item[]): void {
  items = next;
  ui.save(items);
  view?.set(shown());
}

function add(text: string): void {
  const title = text.trim();
  if (title) settle([...items, { id: String(++lastId), title, doneAt: null }]);
}

/** The person ticked or unticked rows: what the lists' checkboxes say now. */
function ticked(card: View): void {
  const checked = new Map<string, boolean>();
  for (const list of ["/open", "/done"]) {
    for (const row of (card.get(list) as { id: string; done: boolean }[] | undefined) ?? []) checked.set(row.id, row.done);
  }
  let changed = false;
  const next = items.map((item) => {
    const done = checked.get(item.id);
    if (done === undefined || done === (item.doneAt !== null)) return item;
    changed = true;
    return { ...item, doneAt: done ? Date.now() : null };
  });
  if (changed) settle(next);
}

function openCard(): void {
  view = ui.open("todo", {
    mode: "floating", title: "To-do", width: 360,
    spec: {
      root: "root",
      state: { ...shown(), draft: "", tab: "open" },
      elements: {
        root: { type: "Stack", props: { gap: "md" }, children: ["head", "draft", "tabs", "openPart", "donePart"] },
        head: { type: "Stack", props: { direction: "horizontal", justify: "between", align: "center" }, children: ["day", "left"] },
        day: { type: "Heading", props: { text: { $state: "/day" }, level: 3 }, children: [] },
        left: { type: "Badge", props: { text: { $state: "/left" }, tone: { $state: "/leftTone" } }, children: [] },
        draft: { type: "TextField", children: [], on: { submit: { action: "add" } },
                 props: { value: { $bindState: "/draft" }, placeholder: "Add a to-do, then Return" } },
        tabs: { type: "Tabs", children: [],
                props: { options: [{ value: "open", label: "To do" }, { value: "done", label: "Done" }], value: { $bindState: "/tab" } } },
        openPart: { type: "Stack", props: { gap: "sm" }, visible: { $state: "/tab", eq: "open" }, children: ["openList", "noneOpen"] },
        openList: { type: "List", props: {}, repeat: { statePath: "/open", key: "id" }, children: ["openItem"] },
        openItem: { type: "Checkbox", props: { label: { $item: "title" }, checked: { $bindItem: "done" } }, children: [] },
        noneOpen: { type: "Text", props: { text: "Nothing left to do.", tone: "muted" }, visible: { $state: "/noneOpen" }, children: [] },
        donePart: { type: "Stack", props: { gap: "sm" }, visible: { $state: "/tab", eq: "done" }, children: ["doneList", "noneDone", "clear"] },
        doneList: { type: "List", props: {}, repeat: { statePath: "/done", key: "id" }, children: ["doneItem"] },
        doneItem: { type: "Checkbox", props: { label: { $item: "title" }, checked: { $bindItem: "done" } }, children: [] },
        noneDone: { type: "Text", props: { text: "Nothing ticked off yet.", tone: "muted" }, visible: { $state: "/noneDone" }, children: [] },
        clear: { type: "Button", props: { label: "Clear done", size: "small" }, visible: { $state: "/hasDone" }, children: [],
                 on: { press: { action: "clear" } } },
      },
    },
  });
  view.on("add", (_, card) => {
    add(String(card.get("/draft") ?? ""));
    card.set({ draft: "" });
  });
  view.on("clear", () => settle(items.filter((item) => item.doneAt === null)));
  view.onChange((_, card) => ticked(card));
  view.onClose(() => (view = undefined));
}

// Told by another program: a string, or { text }, is a new to-do; it answers with how many are left.
ui.onMessage((message) => {
  const text = typeof message === "string" ? message
    : message && typeof message === "object" && typeof (message as { text?: unknown }).text === "string"
      ? (message as { text: string }).text : "";
  add(text);
  if (!view) openCard();
  return { left: items.filter((item) => item.doneAt === null).length };
});
ui.onShow(() => {
  if (!view) openCard();
});

openCard();
// The day in the heading turns over at midnight.
setInterval(() => view?.set({ day: today() }), 60_000);
