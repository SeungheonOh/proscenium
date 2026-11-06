// Timer: a countdown that is a program of its own. It owns its card and runs
// the clock itself (presets, start and pause, a minute more, reset), says so
// over everything when the time is up, keeps counting and alerts after its card
// is closed, and picks up where it was after a restart.
//
//     proscenium-ui start timer

import { app, type View } from "proscenium-app";

interface Saved {
  /** The preset chosen, in minutes. */
  minutes: number;
  /** This run's whole length in ms: the preset and any minutes added. */
  total: number;
  /** When it ends, while it runs. */
  endsAt: number | null;
  /** What is left while it does not run, in ms. */
  left: number;
  done: boolean;
}

const presets = [5, 15, 25, 50];
const fresh = (minutes: number): Saved => ({ minutes, total: minutes * 60_000, endsAt: null, left: minutes * 60_000, done: false });

const ui = app();
let saved = ui.load<Saved>(fresh(25));
// The last run's "Time's up" is old news: start this one fresh.
if (saved.done) saved = fresh(saved.minutes);
let view: View | undefined;
let shownBefore = "";

const remaining = () => (saved.endsAt === null ? saved.left : Math.max(0, saved.endsAt - Date.now()));

function face(ms: number): string {
  const whole = Math.ceil(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const clock = `${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
  return hours ? `${hours}:${clock}` : clock;
}

const minutes = (ms: number) => (Math.round(ms / 60_000) === 1 ? "1 minute" : `${Math.round(ms / 60_000)} minutes`);

/** What the card shows, as its state. */
function shown(): Record<string, unknown> {
  const left = remaining();
  const running = saved.endsAt !== null;
  const paused = !running && !saved.done && left < saved.total;
  const ends = running ? new Date(saved.endsAt!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
  return {
    time: face(left),
    status: saved.done ? "Time's up" : running ? `Ends at ${ends}` : paused ? "Paused" : minutes(saved.total),
    progress: saved.total ? 1 - left / saved.total : 0,
    toggle: running ? "Pause" : saved.done ? "Again" : paused ? "Resume" : "Start",
    tone: saved.done ? "success" : "accent",
    statusTone: saved.done ? "success" : "muted",
    preset: String(saved.minutes),
  };
}

/** Send what changed on the card: the clock's face changes once a second. */
function refresh(): void {
  const values = shown();
  const now = JSON.stringify(values);
  if (now === shownBefore) return;
  shownBefore = now;
  view?.set(values);
}

/** SAVED as it is now: kept, shown, and while it runs, kept running with no card open. */
function settle(next: Saved): void {
  saved = next;
  ui.save(saved);
  ui.background = saved.endsAt !== null;
  refresh();
}

function openCard(): void {
  shownBefore = JSON.stringify(shown());
  view = ui.open("timer", {
    mode: "floating", title: "Timer", width: 300,
    spec: {
      root: "root",
      state: shown(),
      elements: {
        root: { type: "Stack", props: { gap: "lg" }, children: ["face", "progress", "presets", "controls"] },
        face: { type: "Stack", props: { gap: "xs", align: "center" }, children: ["time", "status"] },
        time: { type: "Text", props: { text: { $state: "/time" }, size: "3xl", weight: "bold" }, children: [] },
        status: { type: "Text", props: { text: { $state: "/status" }, tone: { $state: "/statusTone" }, size: "sm" }, children: [] },
        progress: { type: "ProgressBar", props: { value: { $state: "/progress" }, tone: { $state: "/tone" } }, children: [] },
        presets: {
          type: "Tabs", children: [],
          props: { options: presets.map((minutes) => ({ value: String(minutes), label: `${minutes} min` })),
                   value: { $bindState: "/preset" } },
          on: { change: { action: "preset" } },
        },
        controls: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: ["toggle", "more", "gap", "reset"] },
        toggle: { type: "Button", props: { label: { $state: "/toggle" }, variant: "filled" }, children: [],
                  on: { press: { action: "toggle" } } },
        more: { type: "Button", props: { label: "+1 min", variant: "tinted" }, children: [], on: { press: { action: "more" } } },
        gap: { type: "Spacer", props: {}, children: [] },
        reset: { type: "Button", props: { label: "Reset" }, children: [], on: { press: { action: "reset" } } },
      },
    },
  });
  view.on("toggle", () => {
    if (saved.endsAt !== null) settle({ ...saved, endsAt: null, left: remaining() });
    else if (saved.done) settle({ ...fresh(saved.minutes), endsAt: Date.now() + saved.minutes * 60_000 });
    else settle({ ...saved, endsAt: Date.now() + saved.left });
  });
  view.on("more", () => {
    if (saved.done) settle({ ...saved, done: false, total: 60_000, left: 60_000 });
    else if (saved.endsAt !== null) settle({ ...saved, total: saved.total + 60_000, endsAt: saved.endsAt + 60_000 });
    else settle({ ...saved, total: saved.total + 60_000, left: saved.left + 60_000 });
  });
  view.on("reset", () => settle(fresh(saved.minutes)));
  view.on("preset", (_, card) => {
    const minutes = Number(card.get("/preset"));
    if (presets.includes(minutes)) settle(fresh(minutes));
  });
  view.onClose(() => (view = undefined));
}

// Closed while it ran, the note is all it shows: it quits once the note goes, unless the card was opened again.
function finish(): void {
  settle({ ...saved, endsAt: null, left: 0, done: true });
  ui.notify(`${minutes(saved.total)} ${saved.total === 60_000 ? "is" : "are"} up.`, { title: "Time's up", seconds: 15 });
}

// Asked for again while it counts with no card open (from the chat or `proscenium-ui start timer`).
ui.onShow(() => {
  if (!view) openCard();
});

openCard();
ui.background = saved.endsAt !== null;
if (saved.endsAt !== null && remaining() <= 0) finish();
setInterval(() => {
  if (saved.endsAt === null) return;
  if (remaining() <= 0) finish();
  refresh();
}, 250);
