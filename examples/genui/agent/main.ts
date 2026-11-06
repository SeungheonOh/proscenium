// The assistant: a Pi agent (https://pi.dev) that chats in the world's panel and
// makes interfaces as it answers. It is a program of the generated UI protocol
// like any other, the one that keeps the chat (protocol.ts); the world starts it
// when the chat first opens (GenerativeUI.tsx).
//
// It writes interfaces as json-render specs through its ui_render tool. Pi
// streams a tool call's arguments as the model writes them, so each patch goes
// to the world as soon as it is complete and the interface builds up while the
// model is still writing it. The shell runs only once the person allows it, on
// a card in the chat.
//
// For anything with logic of its own (a timer that alerts, a tracker that
// saves) it writes an app instead: a TypeScript program using app.ts, which the
// world runs as a process of its own that owns its interfaces (apps.ts). The
// person allows each app's code once, as with a command.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, createBashToolDefinition, createExtensionRuntime, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, defineTool, SessionManager,
  SettingsManager, type AgentSession, type ResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appLog, trashApp } from "../apps.js";
import { UIClient, type JsonPatch, type Result } from "../client.js";
import { appName, appsFolder, type ChatMessage, type ChatPart, type Mode, type Place } from "../protocol.js";
import { makeEngine, renewSignIn, signInExpired, type Engine } from "./models.js";

const home = userInfo().homedir;
const state = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "proscenium", "assistant");
mkdirSync(state, { recursive: true });
const parent = process.ppid;

const ui = new UIClient({ name: "Assistant", agent: true });

/** With $PROSCENIUM_ASSISTANT_LOG set, what Pi says goes to that file, a line each. */
const logFile = process.env.PROSCENIUM_ASSISTANT_LOG;
function debug(what: unknown): void {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} ${JSON.stringify(what).slice(0, 2000)}\n`);
}

// The chat as the world shows it.
let messages: ChatMessage[] = [];
let serial = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(serial++).toString(36)}`;

/** The reply being written, one chat message for a whole run of turns. */
let reply: ChatMessage | null = null;
/** Parts of the reply from finished model messages; the current one's are added on top. */
let settledParts: ChatPart[] = [];
let busy = false;
let engine: Engine | null = null;
let session: AgentSession | null = null;
let starting: Promise<AgentSession> | null = null;
let catalog = "";
/** An interface this chat made, and where it is: what ui_read and the prompt can say. */
interface Made {
  title?: string;
  mode: Mode;
  /** The chat message it lives in; none once New chat left it outside the chat. */
  message?: string;
  /** For a shell command's approval card: whether it still waits for an answer. */
  approval?: "pending" | "decided";
}
const made = new Map<string, Made>();
/** The titles of apps this assistant wrote or saw, by name, for its chips and labels. */
const knownApps = new Map<string, string>();
/** Commands the person allowed for the rest of this chat. */
let allowAll = false;
type Answer = "run" | "always" | "deny";
/** Approval cards awaiting an answer; closing one is an answer too (CLOSED, no card to mark). */
const approvals = new Map<string, (answer: Answer, closed?: boolean) => void>();

// The chat outlives this process: its transcript, the interfaces it made (as the
// client keeps them, to open again), the Pi session's file and what the person
// allowed are saved in chat.json and restored when the assistant starts again,
// as after the compositor restarts.
const savedFile = join(state, "chat.json");
const sessionDir = join(state, "sessions");
let sessionFile: string | undefined;

interface Saved {
  messages: ChatMessage[];
  made: [string, Made][];
  /** Live data the person allowed, started again with the assistant. */
  feeds?: Feed[];
  records: ReturnType<UIClient["records"]>;
  session?: string;
  allowAll?: boolean;
}

function load(): void {
  let saved: Saved;
  try {
    saved = JSON.parse(readFileSync(savedFile, "utf8")) as Saved;
  } catch {
    return;
  }
  // A reply cut off when the assistant stopped stays cut off.
  messages = (saved.messages ?? []).map((message) =>
    message.streaming ? { ...message, streaming: false, error: message.error ?? "Interrupted." } : message);
  for (const [id, known] of saved.made ?? []) made.set(id, known);
  for (const feed of saved.feeds ?? []) startFeed(feed);
  sessionFile = saved.session;
  allowAll = saved.allowAll === true;
  ui.restore(saved.records ?? {});
  // Nothing waits on an approval from before any more: it is marked not run.
  for (const [id, known] of made) {
    if (known.approval !== "pending") continue;
    known.approval = "decided";
    void ui.patch(id, [decision("deny")]);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Save soon: something the chat keeps changed. */
function changed(): void {
  saveTimer ??= setTimeout(save, 500);
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const saved: Saved = { messages, made: [...made], feeds: [...feeds.values()].map((running) => running.feed),
                         records: ui.records(), session: sessionFile, allowAll };
  writeFileSync(`${savedFile}.new`, JSON.stringify(saved));
  renameSync(`${savedFile}.new`, savedFile);
}

// The model is known from the start, so the chat can name it before the first question.
const engineReady = makeEngine(state);
engineReady.then((made) => {
  engine = made;
  ui.send({ op: "status", busy, model: made.label });
}, (error) => console.error(`[assistant] ${error instanceof Error ? error.message : error}`));

ui.on("connect", () => {
  ui.send({ op: "chat", messages });
  ui.send({ op: "status", busy, model: engine?.label });
});

ui.on("disconnect", () => {
  // The world went away for good when the director that started this did.
  if (process.ppid !== parent) process.exit(0);
});

ui.on("prompt", (text) => void ask(text, { role: "user", parts: [{ type: "text", text }] }));
ui.on("abort", () => void session?.abort());
ui.on("reset", () => void reset());
ui.on("closed", ({ id }) => {
  // Closing an approval card is declining it; closing an interface ends its live data.
  approvals.get(id)?.("deny", true);
  stopFeedsOf(id);
  made.delete(id);
  changed();
});
ui.on("placed", ({ id, mode }) => {
  const known = made.get(id);
  if (known) known.mode = mode;
  changed();
});
ui.on("state", () => changed());
// A newer assistant took the chat: this one is done.
ui.on("fatal", () => process.exit(0));

ui.on("action", ({ id, action, params, state: values }) => {
  const approval = approvals.get(id);
  if (approval) {
    if (action === "run" || action === "always" || action === "deny") approval(action);
    return;
  }
  const title = made.get(id)?.title ?? id;
  // The text of an ask is the model's own instruction to itself; the person only needs to see where it came from.
  const note = action === "ask" ? `Sent from ${title}` : `“${action}” in ${title}`;
  void ask(
    `[The person used the interface "${id}" (${title}): action "${action}" with params ${JSON.stringify(params)}. `
    + `Its state now: ${JSON.stringify(values)}]\nAct on it. To change that interface, call ui_render with id "${id}" and only the patches that change it.`,
    { role: "event", parts: [{ type: "text", text: note }] },
  );
});

process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => save());
process.on("unhandledRejection", (error) => console.error("[assistant]", error));

function publish(message: ChatMessage): void {
  const at = messages.findIndex((existing) => existing.id === message.id);
  // Deltas that change nothing shown (a tool call's arguments) send nothing.
  if (at >= 0 && JSON.stringify(messages[at]) === JSON.stringify(message)) return;
  if (at >= 0) messages[at] = message;
  else messages.push(message);
  ui.send({ op: "message", message });
  changed();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Send the reply as it stands, at most every 40 ms while it streams. */
function publishReply(now = false): void {
  if (!reply) return;
  if (now) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    return publish(reply);
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (reply) publish(reply);
  }, 40);
}

function setBusy(value: boolean, error?: string | null): void {
  busy = value;
  ui.send({ op: "status", busy, model: engine?.label, error });
}

/** A New chat in progress, which whatever the person says next waits for. */
let resetting: Promise<void> | null = null;

function reset(): Promise<void> {
  resetting ??= clear().finally(() => { resetting = null; });
  return resetting;
}

async function clear(): Promise<void> {
  await session?.abort();
  session?.dispose();
  session = null;
  starting = null;
  sessionFile = undefined;
  // Interfaces still in the chat go with it; ones the person moved out stay where
  // they are, with no chat message to go back to.
  for (const [id, known] of made) {
    if (known.mode === "inline") {
      stopFeedsOf(id);
      ui.close(id);
      made.delete(id);
    } else if (known.message) {
      known.message = undefined;
      ui.update(id, { message: null });
    }
  }
  allowAll = false;
  messages = [];
  reply = null;
  ui.send({ op: "chat", messages });
  setBusy(false, null);
  changed();
}

/** Say TEXT to the model, showing SHOWN in the chat; queued after the current run if one is going. */
async function ask(text: string, shown: Omit<ChatMessage, "id">): Promise<void> {
  // Said just after New chat: it belongs to the new chat, so wait for the old one to be gone.
  if (resetting) await resetting;
  publish({ ...shown, id: nextId("m") });
  let current: AgentSession;
  try {
    current = await open();
  } catch (error) {
    return setBusy(false, `The assistant could not start: ${error instanceof Error ? error.message : error}`);
  }
  if (current.isStreaming) {
    current.followUp(text);
    return;
  }
  await run(current, text, true);
}

async function run(current: AgentSession, text: string, retry: boolean): Promise<void> {
  reply = { id: nextId("r"), role: "assistant", parts: [], streaming: true };
  settledParts = [];
  publishReply(true);
  setBusy(true, null);
  let failure: string | undefined;
  try {
    await current.prompt(text, { expandPromptTemplates: false });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  failure ??= reply?.error;
  if (failure && retry && signInExpired(failure) && await renewSignIn()) {
    if (reply) messages = messages.filter((message) => message.id !== reply!.id);
    ui.send({ op: "chat", messages });
    return run(current, text, false);
  }
  if (reply) {
    reply = { ...reply, streaming: false, error: failure ?? reply.error };
    publishReply(true);
  }
  reply = null;
  setBusy(false, null);
}

function open(): Promise<AgentSession> {
  if (session) return Promise.resolve(session);
  starting ??= (async () => {
    engine ??= await engineReady;
    if (!catalog) catalog = (await ui.catalog()).prompt ?? "";
    const created = await createAgentSession({
      cwd: home, agentDir: join(state, "pi"), model: engine.model, modelRuntime: engine.runtime,
      thinkingLevel: (process.env.PROSCENIUM_ASSISTANT_THINKING as never) || "low",
      resourceLoader: resources(systemPrompt()),
      noTools: "builtin",
      customTools: tools(),
      sessionManager: openSession(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
    });
    const fresh = created.session;
    sessionFile = fresh.sessionManager.getSessionFile();
    changed();
    if (engine.payload) fresh.agent.onPayload = engine.payload as never;
    fresh.subscribe(listen);
    session = fresh;
    ui.send({ op: "status", busy, model: engine.label });
    return fresh;
  })();
  return starting;
}

/** The chat's Pi session: the one it had before a restart, or a new one. */
function openSession(): SessionManager {
  mkdirSync(sessionDir, { recursive: true });
  if (sessionFile && existsSync(sessionFile)) {
    try {
      return SessionManager.open(sessionFile, sessionDir);
    } catch (error) {
      console.error(`[assistant] could not reopen ${sessionFile}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return SessionManager.create(home, sessionDir);
}

function resources(prompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }) as never,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function systemPrompt(): string {
  const today = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
  return `You are the assistant built into Proscenium, the person's Wayland desktop. You talk with them in a chat panel at the side of the screen, and you can make native interfaces that appear on their desktop: you are the desktop's generative UI.

It is ${today}. The person's home is ${home}. Their computer runs Linux.

HOW TO ANSWER
- Short answers, in plain words. Markdown is rendered (bold, lists, code).
- When an interface helps more than text (a timer, a checklist, a form, a dashboard, a comparison, a chart, controls, a summary card), make one with ui_render and keep your text to a sentence. Don't make an interface for a plain fact or a greeting.
- Use real data. Find it first with your tools (bash, read, ls, grep, find): disk usage, files, processes, battery, git status. Only invent sample data when asked for a mock-up.
- The shell asks the person before each command (they can allow the rest of the chat). Prefer one command that gets everything over many small ones. Never run anything destructive without being asked.

INTERFACES
- ui_render makes an interface (a new id) or changes one (an id you used before: send only the patches that change it, e.g. replace one element or set state).
- Modes: "inline" (default: inside your chat message), "floating" (a card on the screen), "overlay" (pinned over everything in a corner, \`anchor\`: top-right, top-left, bottom-right, bottom-left, top, bottom), "dock" (a panel along an edge, \`side\`: left or right; windows make room), "canvas" (in the world, panning with the windows), "dialog" (centred, over a dimmed screen, until answered). Use inline unless the person asks for it somewhere, or it should outlive the chat (a timer, a monitor: overlay or floating). The person can drag interfaces between modes; ui_place moves one, ui_close closes one, ui_read reads its state.
- Live data (a system monitor, a download's progress, a build's status, prices, anything that changes on its own): make the interface with state paths for the values, then call ui_feed with a shell command that prints them; it refreshes the state every few seconds after you have answered, until the interface closes. For several values print one "name value" pair per line and use into "/" (no JSON quoting needed); keep: N keeps the last N values of one path as a list, for a Sparkline.
- Interfaces work on their own with setState/pushState/removeState (tabs, toggles, adding and ticking items). For anything that needs you (searching, computing, fetching, deciding), bind a button to {"action":"ask","params":{"text":"what to do"}}: you then get a message with the interface's whole state, and can update it.
- Keep interfaces compact (about 360 px wide), with a clear title and few words. One root element (usually a Card or Stack).

APPS
- An app is a program of its own that owns its interfaces and runs their logic: the world starts it as its own process, it keeps running when you stop or the chat is reset, it starts again after a restart, and it can do anything a Node program can (keep time, alert, save data, read files, run commands, fetch). Write one when the person asks for an app, or when an interface needs logic that setState and ui_feed can't give: a timer that alerts and survives restarts, a pomodoro with rounds, a stopwatch with laps, a tracker or journal that saves entries, a game, a watcher that notifies. For a plain card, a ui_render interface is simpler.
- app_write saves main.ts and starts it (again, for a name used before). Its result says what it showed, what is wrong with each spec and its log: fix and write it again until it is clean. app_control starts (an app already running shows itself), stops, restarts or deletes one; app_list lists them and gives an app's main.ts path, to read before you change it. An app's interfaces are its own: you can't ui_render, ui_feed or ui_close them. Change the code.
- main.ts runs under Node 22. Import only node: modules and "proscenium-app", the app library:
  import { app, type View } from "proscenium-app";
  const ui = app();                                   // connects; it quits once it shows nothing (the person closed its last interface)
  const view = ui.open("main", { mode: "floating", title: "Timer", width: 300, spec: { root: "root", state: { left: "25:00" }, elements: { ... } } });
  view.on("start", (params, view) => { ... });       // an element's on.press: { action: "start", params: { ... } } calls it
  view.set({ left: "24:59", running: true });         // state keys, or JSON pointers: view.set("/items/0/done", true)
  view.get("/text"); view.state;                      // the state now, with what the person typed or toggled
  view.onChange((state) => { ... });                  // the person changed state (typing, switches, tabs)
  view.element("label", { type: "Text", props: { text: "Hi" }, children: [] }); view.patch([...]);  // change the spec
  view.update({ title: "Done" }); view.place("overlay", { anchor: "top-right" }); view.close(); view.onClose(() => { ... });
  ui.notify("Time's up", { title: "Timer", seconds: 10 });      // a note over everything, in a corner
  const data = ui.load({ entries: [] as string[] }); ui.save(data);   // its own data, kept across restarts
  ui.background = true;                               // keep running with nothing open (a timer that still alerts, a watcher that only notifies)
  ui.onShow(() => { if (!view.open) ... });           // asked for again while running: open what it shows
  setInterval(tick, 250); Date.now() for time; plain console.error goes to its log.
- In an app's specs, setState, pushState, removeState, close and copy still run in the world at once; every other action goes to the app's view.on handler, with its params (ask has no assistant behind it in an app). Bind what changes to state and set it from the app; compute display text (e.g. "04:59") in the app. Keep the state small, and set it when it changes, not on every tick.
- Give the spec's state every value it shows from the start (the clock's first face too): a path nothing set yet shows as nothing. Open the interface in a function, so ui.onShow can open it again after the person closed it while the app ran in the background.
- The person reads the code before allowing it: write it plainly, one statement a line, with a comment where it helps, in one go (types, the spec, the handlers, saving), under about 200 lines.

${catalog}`;
}

// What Pi says, turned into the chat message the world shows.

interface Rendering {
  id?: string;
  sent: number;
  opened: boolean;
  mode?: Mode;
  /** It changed an interface already open and asked for another mode, which only ui_place gives. */
  stays?: boolean;
}

const renderings = new Map<string, Rendering>();

function listen(event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void {
  if (logFile) {
    const update = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
    debug(event.type === "message_update" ? { e: update?.type, d: update?.delta }
      : event.type === "message_end" ? { e: "message_end", m: event.message }
      : { e: event.type, tool: (event as { toolName?: string }).toolName, result: (event as { result?: unknown }).result });
  }
  if (!reply) return;
  switch (event.type) {
    case "message_update": {
      const message = event.message as { role?: string; content?: unknown[] };
      if (message.role !== "assistant") return;
      reply = { ...reply, parts: once([...settledParts, ...partsOf(message.content ?? [], false)]) };
      publishReply();
      return;
    }
    case "message_end": {
      const message = event.message as { role?: string; content?: unknown[]; stopReason?: string; errorMessage?: string };
      if (message.role !== "assistant") return;
      settledParts = once([...settledParts, ...partsOf(message.content ?? [], true)]);
      reply = { ...reply, parts: settledParts };
      if (message.stopReason === "error") reply.error = message.errorMessage ?? "The model failed.";
      if (message.stopReason === "aborted") reply.error = "Stopped.";
      publishReply(true);
      return;
    }
    case "tool_execution_start":
    case "tool_execution_end": {
      const done = event.type === "tool_execution_end";
      const failed = done && (event as { isError?: boolean }).isError === true;
      settledParts = settledParts.map((part) =>
        (part.type === "tool" || part.type === "app") && part.id === event.toolCallId
          ? { ...part, status: done ? (failed ? "error" : "done") : "running" } : part);
      reply = { ...reply, parts: settledParts };
      publishReply(true);
      return;
    }
  }
}

/** PARTS with each interface once: a ui_render that repairs one already in the message adds nothing to show. */
function once(parts: ChatPart[]): ChatPart[] {
  const shown = new Set<string>();
  return parts.filter((part) => part.type !== "ui" || (!shown.has(part.id) && shown.add(part.id)));
}

/** Chat parts for a model message's CONTENT; tool calls of ui_render become their interface. */
function partsOf(content: unknown[], ended: boolean): ChatPart[] {
  const parts: ChatPart[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
    else if (item.type === "thinking" && typeof item.thinking === "string") parts.push({ type: "thinking", text: item.thinking });
    else if (item.type === "toolCall") {
      const call = item as { id: string; name: string; arguments?: Record<string, unknown> };
      if (call.name === "ui_render") {
        const id = stream(call.id, call.arguments ?? {}, ended);
        const known = id ? made.get(id) : undefined;
        if (id && (!known || known.message === reply?.id)) parts.push({ type: "ui", id });
        else if (id) parts.push({ type: "tool", id: call.id, name: call.name, label: `Updating ${known?.title ?? id}`, status: "running" });
      } else if (call.name === "app_write" || call.name === "app_control" && appStarts(call.arguments ?? {})) {
        // Its arguments are whole once the model's message has ended; until then only the label shows.
        const args = call.arguments ?? {};
        const name = ended ? str(args.name) : undefined;
        const title = ended ? str(args.title) ?? (name && knownApps.get(name)) ?? name : undefined;
        const label = call.name === "app_write" ? (title ? `Writing the ${title} app` : "Writing an app")
          : `${args.action === "restart" ? "Restarting" : "Starting"} ${title ?? "an app"}`;
        parts.push({ type: "app", id: call.id, name, title, label, status: "running" });
      } else {
        parts.push({ type: "tool", id: call.id, name: call.name, label: toolLabel(call.name, call.arguments ?? {}), status: "running" });
      }
    }
  }
  return parts;
}

/**
 * Send what has arrived of a ui_render call: open its interface once its id
 * is known and then each patch once the next one starts (or the call ends),
 * as a patch still being written may be cut short.
 */
function stream(callId: string, args: Record<string, unknown>, ended: boolean): string | undefined {
  // Pi reads half-written arguments, strings included: the id, mode and title
  // before the patches are whole once the patches have begun.
  if (!ended && !Array.isArray(args.patches)) return undefined;
  const id = typeof args.id === "string" && args.id ? args.id : undefined;
  if (!id) return undefined;
  let rendering = renderings.get(callId);
  if (!rendering) renderings.set(callId, (rendering = { id, sent: 0, opened: false }));
  const patches = Array.isArray(args.patches) ? (args.patches as JsonPatch[]) : [];
  const ready = ended ? patches.length : Math.max(0, patches.length - 1);
  if (!rendering.opened) {
    rendering.opened = true;
    const known = made.get(id);
    const width = typeof args.width === "number" ? args.width : undefined;
    const theme = args.theme === "dark" ? "dark" : args.theme === "light" ? "light" : undefined;
    if (known) {
      // Changing an interface never moves it: where it is may be where the person put it.
      rendering.mode = known.mode;
      rendering.stays = typeof args.mode === "string" && args.mode !== known.mode;
      if (str(args.title)) known.title = str(args.title);
      void ui.open(id, { title: str(args.title), width, theme });
    } else {
      const mode = (typeof args.mode === "string" ? args.mode : "inline") as Mode;
      rendering.mode = mode;
      made.set(id, { title: str(args.title), mode, message: reply!.id });
      void ui.open(id, { mode, place: placeOf(args), title: str(args.title), width, theme, message: reply!.id });
    }
  }
  if (rendering.opened && ready > rendering.sent) {
    void ui.patch(id, patches.slice(rendering.sent, ready));
    rendering.sent = ready;
  }
  return id;
}

/** An app_control call that starts its app, which shows as the app's chip once done. */
function appStarts(args: Record<string, unknown>): boolean {
  return args.action === "start" || args.action === "restart";
}

function placeOf(args: Record<string, unknown>): Place | undefined {
  const place: Place = {};
  if (typeof args.anchor === "string") place.anchor = args.anchor as Place["anchor"];
  if (args.side === "left" || args.side === "right") place.side = args.side;
  return Object.keys(place).length ? place : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const cut = (text: unknown, length = 64) => {
    const words = String(text ?? "").replace(/\s+/g, " ").trim();
    return words.length > length ? `${words.slice(0, length - 1)}…` : words;
  };
  switch (name) {
    case "bash": return `$ ${cut(args.command)}`;
    case "read": return `Reading ${cut(args.path)}`;
    case "ls": return `Listing ${cut(args.path ?? ".")}`;
    case "grep": return `Searching for ${cut(args.pattern, 40)}`;
    case "find": return `Finding ${cut(args.pattern, 40)}`;
    case "ui_place": return `Moving ${made.get(String(args.id))?.title ?? args.id} ${args.mode ? `to ${args.mode}` : ""}`;
    case "ui_close": return `Closing ${made.get(String(args.id))?.title ?? args.id}`;
    case "ui_read": return `Reading ${made.get(String(args.id))?.title ?? args.id}`;
    case "ui_feed": return args.stop ? `Stopping live data for ${made.get(String(args.id))?.title ?? args.id}`
      : `Live data for ${made.get(String(args.id))?.title ?? args.id}${args.every ? ` every ${args.every} s` : ""}`;
    case "app_list": return args.name ? `Looking at ${knownApps.get(String(args.name)) ?? args.name}` : "Listing apps";
    case "app_control": return `${args.action === "delete" ? "Deleting" : "Stopping"} ${knownApps.get(String(args.name)) ?? args.name ?? "an app"}`;
    default: return name;
  }
}

// Tools.

const modeType = Type.Union(["inline", "floating", "overlay", "dock", "canvas", "dialog"].map((mode) => Type.Literal(mode)));
const anchorType = Type.Union(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]
  .map((anchor) => Type.Literal(anchor)));

function text(words: string) {
  return { content: [{ type: "text" as const, text: words }], details: undefined };
}

function tools(): ToolDefinition[] {
  const render = defineTool({
    name: "ui_render",
    label: "Interface",
    description: "Make a native interface on the desktop from json-render patches (see UI FORMAT), or change one you made by its id, where it is (mode applies only when it is new; ui_place moves one). Returns what is wrong with the spec, if anything.",
    parameters: Type.Object({
      id: Type.String({ description: "Short id, e.g. \"timer\". The same id changes that interface." }),
      mode: Type.Optional(modeType),
      title: Type.Optional(Type.String({ description: "Shown on its title bar." })),
      anchor: Type.Optional(anchorType),
      side: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
      width: Type.Optional(Type.Number({ description: "Pixels, for floating, overlay, dock or canvas." })),
      theme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
      patches: Type.Array(Type.Object({
        op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
        path: Type.String(),
        value: Type.Optional(Type.Unknown()),
      }), { description: "JSON Patch operations, in order: /root, /elements/<key>, /state/<path>." }),
    }),
    async execute(callId, params) {
      // Normally streamed already; a call that never streamed is sent whole now.
      if (!renderings.get(callId)?.opened) stream(callId, params as Record<string, unknown>, true);
      const rendering = renderings.get(callId)!;
      const rest = params.patches.slice(rendering.sent);
      rendering.sent = params.patches.length;
      const result = await ui.patch(params.id, rest as JsonPatch[]);
      if (!result.ok) return text(`Could not show it: ${result.error}`);
      const problems = result.problems ?? [];
      const where = made.get(params.id)?.mode || rendering.mode || "inline";
      const stays = rendering.stays ? ` It stays where it is (${where}); ui_place moves it.` : "";
      return text(problems.length
        ? `Not finished: the interface shows, but it is broken:\n- ${problems.join("\n- ")}\nCall ui_render again now with id "${params.id}" and the patches that add or fix exactly these, before you reply. Don't give up and don't describe the problem to the person.${stays}`
        : `Shown (${where}). Don't describe it again in words.${stays}`);
    },
  });
  const place = defineTool({
    name: "ui_place",
    label: "Move interface",
    description: "Move an interface you made to another mode.",
    parameters: Type.Object({ id: Type.String(), mode: modeType, anchor: Type.Optional(anchorType),
                              side: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])) }),
    async execute(_, params) {
      if (!ui.has(params.id)) return text(`No interface "${params.id}" is open.`);
      if (params.mode === "inline" && !made.get(params.id)?.message) return text("That one never lived in the chat.");
      ui.place(params.id, params.mode as Mode, placeOf(params as Record<string, unknown>));
      const known = made.get(params.id);
      if (known) known.mode = params.mode as Mode;
      return text(`Moved to ${params.mode}.`);
    },
  });
  const close = defineTool({
    name: "ui_close",
    label: "Close interface",
    description: "Close an interface you made.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_, params) {
      stopFeedsOf(params.id);
      ui.close(params.id);
      made.delete(params.id);
      return text("Closed.");
    },
  });
  const read = defineTool({
    name: "ui_read",
    label: "Read interface",
    description: "Read an interface's spec and current state (what the person entered or changed), and where it is.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_, params) {
      const result = await ui.get(params.id);
      if (!result.ok) return text(result.error ?? "Not found.");
      return text(JSON.stringify({ mode: result.mode, place: result.place, state: result.spec?.state,
                                   elements: result.spec?.elements }).slice(0, 20000));
    },
  });
  const bash = createBashToolDefinition(home);
  const askedBash: ToolDefinition = {
    ...bash,
    async execute(callId, params, signal, onUpdate, context) {
      const command = String((params as { command?: unknown }).command ?? "");
      const answer: Answer = allowAll ? "run" : await approve({ heading: "Run a command?", code: command }, signal);
      if (answer === "deny") return text("The person did not allow this command. Ask them, or do without it.");
      if (answer === "always") allowAll = true;
      return bash.execute(callId, params as never, signal, onUpdate as never, context);
    },
  } as ToolDefinition;
  const feed = defineTool({
    name: "ui_feed",
    label: "Live data",
    description: "Keep an interface's state up to date from a shell command run every few seconds, after you have answered, until the interface closes. The command prints the value: a number, text, JSON, lines (a list), or, easiest for several values, one \"name value\" pair per line, which fills /name for each when into is \"/\" (e.g. printf 'load %s\\nmemory %s\\n' ...). Returns the first value it read, or why the command failed. The person allows the command once. With stop: true, stops a feed.",
    parameters: Type.Object({
      id: Type.String({ description: "The interface." }),
      name: Type.Optional(Type.String({ description: "Names the feed, to replace or stop it; \"data\" by default." })),
      command: Type.Optional(Type.String({ description: "A shell command printing the value, e.g. \"cat /proc/loadavg | cut -d' ' -f1\"." })),
      every: Type.Optional(Type.Number({ description: "Seconds between runs, 1 to 3600; 2 by default." })),
      into: Type.Optional(Type.String({ description: "The state path it sets, e.g. \"/load\"; \"/\" to fill paths from a printed JSON object." })),
      parse: Type.Optional(Type.Union([Type.Literal("pairs"), Type.Literal("json"), Type.Literal("number"), Type.Literal("text"),
                                       Type.Literal("lines")])),
      keep: Type.Optional(Type.Number({ description: "Keep the last N values as a list at into, for a chart." })),
      stop: Type.Optional(Type.Boolean()),
    }),
    async execute(_, params, signal) {
      if (!ui.has(params.id)) return text(`No interface "${params.id}" is open.`);
      const name = params.name || "data";
      if (params.stop) {
        stopFeed(`${params.id}:${name}`);
        return text("Stopped.");
      }
      if (!params.command) return text("A feed needs a command.");
      const every = Math.min(Math.max(Math.round(params.every ?? 2), 1), 3600);
      const title = made.get(params.id)?.title ?? params.id;
      const answer: Answer = allowAll ? "run" : await approve({ heading: `Update ${title} every ${every} s?`, code: params.command }, signal);
      if (answer === "deny") return text("The person did not allow this command.");
      if (answer === "always") allowAll = true;
      const feed: Feed = { id: params.id, name, command: params.command, every, into: params.into || "/value",
                           parse: params.parse, keep: params.keep ? Math.min(Math.max(Math.round(params.keep), 2), 500) : undefined };
      // A command that fails at once is not left running: the model fixes it and calls again.
      stopFeed(`${feed.id}:${feed.name}`);
      const first = await runOnce(feed);
      if (!first.ok) {
        return { ...text(`Not started: the command failed: ${first.error}. Fix it and call ui_feed again (same name).`), isError: true };
      }
      startFeed(feed);
      changed();
      return text(`Live: ${title} updates every ${every} s. First value: ${JSON.stringify(first.value).slice(0, 400)}`);
    },
  });
  const writeApp = defineTool({
    name: "app_write",
    label: "Write app",
    description: "Write an app (see APPS): a TypeScript program that owns its interfaces and runs their logic as a process of its own, apart from you and the chat. Saves it as main.ts in the person's apps folder and starts it, or with a name used before, replaces it and starts it again. The person allows its code first. Returns what it showed, what is wrong with each spec and its log.",
    parameters: Type.Object({
      name: Type.String({ description: "Its folder name: lower case letters, digits and dashes, e.g. \"focus-timer\"." }),
      title: Type.String({ description: "What it is called, e.g. \"Focus timer\"." }),
      description: Type.String({ description: "One sentence on what it does, shown to the person before it runs." }),
      source: Type.String({ description: "The whole of main.ts." }),
    }),
    async execute(_, params, signal) {
      const name = params.name.trim();
      if (!appName.test(name)) return failed("Name it with lower case letters, digits and dashes, e.g. focus-timer.");
      const dir = join(appsFolder(), name);
      const file = join(dir, "main.ts");
      const lines = params.source.split("\n").length;
      // Writing over an app already there, or putting one of the person's over Proscenium's own of that name.
      const replacing = existsSync(file) || (await ui.apps()).apps?.some((app) => app.name === name);
      const answer: Answer = allowAll ? "run" : await approve({
        heading: `${replacing ? "Replace" : "Run"} the ${params.title} app?`, note: params.description, code: params.source, fold: true,
        where: `${file.replace(home, "~")} · ${lines} lines · runs on its own until it ends or is stopped`,
      }, signal);
      if (answer === "deny") return failed("The person did not allow this app. Ask them what to change.");
      if (answer === "always") allowAll = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, params.source.endsWith("\n") ? params.source : `${params.source}\n`);
      writeFileSync(join(dir, "app.json"), `${JSON.stringify({ title: params.title, description: params.description }, null, 2)}\n`);
      knownApps.set(name, params.title);
      return launched(await ui.launch(name, { restart: true }), file);
    },
  });
  const controlApp = defineTool({
    name: "app_control",
    label: "Control app",
    description: "Start an app (one already running shows itself again), stop it, start it again, or delete one of the person's.",
    parameters: Type.Object({
      name: Type.String(),
      action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart"), Type.Literal("delete")]),
    }),
    async execute(_, params) {
      const { apps = [] } = await ui.apps();
      const app = apps.find((each) => each.name === params.name);
      if (!app) return failed(`No app "${params.name}". app_list lists them.`);
      knownApps.set(app.name, app.title);
      if (params.action === "start" || params.action === "restart") {
        return launched(await ui.launch(app.name, { restart: params.action === "restart" }), join(app.dir, "main.ts"));
      }
      if (params.action === "delete" && app.builtin) return failed("That app ships with Proscenium: it can be stopped, not deleted.");
      const stopped = await ui.stopApp(app.name);
      if (!stopped.ok) return failed(`Could not stop it: ${stopped.error}`);
      if (params.action === "stop") return text("Stopped.");
      // Deleted apps, and their data, go to a trash folder rather than away for good.
      try {
        return text(`Deleted; its folder and data are kept in ${trashApp(app.name).replace(home, "~")}.`);
      } catch (error) {
        return failed(`Could not delete it: ${error instanceof Error ? error.message : error}`);
      }
    },
  });
  const listApps = defineTool({
    name: "app_list",
    label: "Apps",
    description: "List the apps there are (the person's and Proscenium's), whether each runs and what it shows. With a name: that app's folder, its main.ts path (read it before changing it) and its log.",
    parameters: Type.Object({ name: Type.Optional(Type.String()) }),
    async execute(_, params) {
      const { apps = [] } = await ui.apps();
      for (const app of apps) knownApps.set(app.name, app.title);
      if (!params.name) {
        if (!apps.length) return text("No apps yet.");
        return text(apps.map((app) => `- ${app.name}: ${app.title}${app.builtin ? " (ships with Proscenium)" : ""}, `
          + `${app.running ? `running${app.interfaces.length ? `, showing ${app.interfaces.map((each) => each.title ?? each.id).join(", ")}` : " with nothing open"}` : "stopped"}`
          + `${app.description ? `. ${app.description}` : ""}`).join("\n"));
      }
      const app = apps.find((each) => each.name === params.name);
      if (!app) return failed(`No app "${params.name}".`);
      const log = appLog(app.name, 2500);
      return text([
        `${app.title} (${app.name})${app.builtin ? ", ships with Proscenium" : ""}: ${app.running ? `running, pid ${app.pid}` : app.ended ?? "stopped"}.`,
        `Folder: ${app.dir}${existsSync(join(app.dir, "main.ts")) ? ` (main.ts: ${join(app.dir, "main.ts")})` : ""}`,
        ...app.interfaces.map((each) => `Shows ${each.title ?? each.id} (${each.mode})${each.problems.length ? `: ${each.problems.join("; ")}` : ""}`),
        log ? `Log of its last run:\n${log}` : "Its log is empty.",
      ].join("\n"));
    },
  });
  return [render, place, close, read, feed, writeApp, controlApp, listApps, askedBash, createReadToolDefinition(home),
          createLsToolDefinition(home), createGrepToolDefinition(home), createFindToolDefinition(home)] as ToolDefinition[];
}

function failed(words: string) {
  return { ...text(words), isError: true };
}

/** What starting an app came to, for the model: whether it runs, what it shows and what to fix. FILE is its code. */
function launched(result: Result, file: string) {
  const app = result.app;
  const log = result.log?.trim();
  if (!result.ok || !app?.running) {
    return failed(`It did not keep running: ${result.error ?? "it ended"}.${log ? `\nIts log:\n${log}` : ""}\nFix ${file} and write it again.`);
  }
  const problems = app.interfaces.flatMap((each) => each.problems.map((problem) => `${each.title ?? each.id}: ${problem}`));
  const shows = app.interfaces.length
    ? `showing ${app.interfaces.map((each) => `${each.title ?? each.id} (${each.mode})`).join(", ")}` : "showing nothing yet";
  const lines = [`Running as a program of its own (pid ${app.pid}), ${shows}.`];
  if (problems.length) lines.push(`Its interfaces are broken:\n- ${problems.join("\n- ")}\nFix the specs in ${file} and write it again now.`);
  if (log) lines.push(`Its log:\n${log}`);
  if (!problems.length) lines.push("It owns what it shows: change it by writing it again, never with ui_render. Don't describe it again in words.");
  return problems.length ? failed(lines.join("\n")) : text(lines.join("\n"));
}

/** The approval card's buttons, once ANSWER is given: what was decided, in their place. */
function decision(answer: Answer): JsonPatch {
  return { op: "replace", path: "/elements/buttons", value: { type: "Text", children: [], props: {
    text: answer === "deny" ? "Not run." : answer === "always" ? "Ran · commands run freely for the rest of this chat." : "Ran.",
    tone: answer === "deny" ? "muted" : "success", size: "sm" } } };
}

/** What an approval card asks about: a command, or an app's code (folded away under a button, with a NOTE and WHERE). */
interface Asking {
  heading: string;
  code: string;
  note?: string;
  where?: string;
  fold?: boolean;
}

/** Ask the person, on a card in the chat, whether code may run. Closing the card, or stopping, declines. */
function approve(asking: Asking, signal: AbortSignal | undefined): Promise<Answer> {
  const { heading, code, note, where, fold } = asking;
  const id = nextId("approve-");
  const message = reply?.id;
  if (!message) return Promise.resolve("deny");
  settledParts = [...settledParts, { type: "ui", id }];
  reply = { ...reply!, parts: settledParts };
  made.set(id, { title: heading, mode: "inline", message, approval: "pending" });
  void ui.open(id, {
    mode: "inline", title: heading, message,
    spec: {
      root: "card", state: { code: false },
      elements: {
        card: { type: "Stack", props: { gap: "md" },
                children: [...(note ? ["note"] : []), ...(where ? ["where"] : []), ...(fold ? ["show"] : []), "code", "buttons"] },
        note: { type: "Text", props: { text: note ?? "" }, children: [] },
        where: { type: "Text", props: { text: where ?? "", tone: "muted", size: "sm" }, children: [] },
        show: { type: "Button", props: { label: "Show the code", size: "small" }, children: [],
                visible: { $state: "/code", not: true },
                on: { press: { action: "setState", params: { statePath: "/code", value: true } } } },
        code: { type: "Code", props: { text: code }, children: [], ...(fold ? { visible: { $state: "/code" } } : {}) },
        buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: ["run", "always", "deny"] },
        run: { type: "Button", props: { label: "Run", variant: "filled", size: "small" }, children: [],
               on: { press: { action: "run" } } },
        always: { type: "Button", props: { label: "Allow all in this chat", variant: "tinted", size: "small" }, children: [],
                  on: { press: { action: "always" } } },
        deny: { type: "Button", props: { label: "Don't run", size: "small" }, children: [], on: { press: { action: "deny" } } },
      },
    },
  });
  publishReply(true);
  return new Promise((resolve) => {
    const settle = (answer: Answer, closed = false) => {
      approvals.delete(id);
      signal?.removeEventListener("abort", aborted);
      const known = made.get(id);
      if (known) known.approval = "decided";
      // The card stays as a record of what was decided, unless the person closed it.
      if (!closed) void ui.patch(id, [decision(answer)]);
      changed();
      resolve(answer);
    };
    const aborted = () => settle("deny");
    signal?.addEventListener("abort", aborted);
    approvals.set(id, settle);
  });
}

// Live data: a shell command run every few seconds, its output put in an
// interface's state. Feeds belong to the assistant: they run while it does,
// after the turn that made them, and end when their interface closes.

interface Feed {
  id: string;
  name: string;
  command: string;
  every: number;
  into: string;
  parse?: "pairs" | "json" | "number" | "text" | "lines";
  keep?: number;
}

interface Running {
  feed: Feed;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  failures: number;
  /** The last values, for a feed that keeps them. */
  history: unknown[];
}

const feeds = new Map<string, Running>();

function startFeed(feed: Feed): void {
  const key = `${feed.id}:${feed.name}`;
  stopFeed(key);
  const running: Running = { feed, busy: false, failures: 0, history: [] };
  running.timer = setInterval(() => void tick(running), feed.every * 1000);
  feeds.set(key, running);
}

function stopFeed(key: string): void {
  const running = feeds.get(key);
  if (!running) return;
  clearInterval(running.timer);
  feeds.delete(key);
  changed();
}

function stopFeedsOf(id: string): void {
  for (const [key, running] of feeds) if (running.feed.id === id) stopFeed(key);
}

/** Run FEED's command once and put what it printed in its interface's state. */
async function runOnce(feed: Feed): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn("bash", ["-c", feed.command], { cwd: home, stdio: ["ignore", "pipe", "pipe"],
                                                       timeout: Math.min(feed.every * 900, 20_000) });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (out.length < 65536) out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (err.length < 2000) err += chunk; });
    child.on("error", (error) => resolve({ code: -1, out, err: error.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  if (result.code !== 0) return { ok: false, error: result.err.trim().slice(0, 300) || `it exited with ${result.code}` };
  let value: unknown;
  try {
    value = parsed(result.out, feed.parse);
  } catch (error) {
    return { ok: false, error: `its output is not ${feed.parse}: ${error instanceof Error ? error.message : error}` };
  }
  const running = feeds.get(`${feed.id}:${feed.name}`);
  if (feed.keep) {
    const history = running?.history ?? [];
    history.push(value);
    history.splice(0, Math.max(0, history.length - feed.keep));
    ui.state(feed.id, { [feed.into]: [...history] });
  } else if ((feed.into === "/" || feed.into === "") && value && typeof value === "object" && !Array.isArray(value)) {
    ui.state(feed.id, Object.fromEntries(Object.entries(value).map(([key, item]) => [`/${key}`, item])));
  } else {
    ui.state(feed.id, { [feed.into]: value });
  }
  return { ok: true, value };
}

function parsed(output: string, mode: Feed["parse"]): unknown {
  const words = output.trim();
  if (mode === "json") return JSON.parse(words);
  if (mode === "number") {
    const value = Number.parseFloat(words);
    if (!Number.isFinite(value)) throw new Error(`"${words.slice(0, 40)}"`);
    return value;
  }
  if (mode === "lines") return words.split("\n").filter((line) => line.trim());
  if (mode === "text") return words;
  if (mode === "pairs") return pairs(words) ?? (() => { throw new Error("no \"name value\" lines"); })();
  // Unsaid: JSON if it is, name-value lines if they are, a number if it is, else text.
  try {
    return JSON.parse(words);
  } catch {
    const named = pairs(words);
    if (named) return named;
    const value = Number(words);
    return words !== "" && Number.isFinite(value) ? value : words;
  }
}

/** "name value" lines (or name=value, name: value) as an object, numbers as numbers; null if any line is not one. */
function pairs(words: string): Record<string, unknown> | null {
  const lines = words.split("\n").filter((line) => line.trim());
  if (!lines.length) return null;
  const found: Record<string, unknown> = {};
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][\w.-]*)\s*(?:=|:|\s)\s*(.*?)\s*$/.exec(line);
    if (!match) return null;
    const value = Number(match[2]);
    found[match[1]!] = match[2] !== "" && Number.isFinite(value) ? value : match[2];
  }
  return found;
}

/** One run of a feed; three failures in a row stop it, and the chat says why. */
async function tick(running: Running): Promise<void> {
  if (running.busy || !ui.has(running.feed.id)) return;
  running.busy = true;
  const result = await runOnce(running.feed);
  running.busy = false;
  if (result.ok) {
    running.failures = 0;
    return;
  }
  if (++running.failures < 3) return;
  stopFeed(`${running.feed.id}:${running.feed.name}`);
  const title = made.get(running.feed.id)?.title ?? running.feed.id;
  publish({ id: nextId("m"), role: "event", parts: [{ type: "text", text: `Stopped updating ${title}: ${result.error}` }] });
}

// Last, once everything it uses is defined, and before the client connects.
load();
