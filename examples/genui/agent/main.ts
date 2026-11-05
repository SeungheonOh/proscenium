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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, createBashToolDefinition, createExtensionRuntime, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, defineTool, SessionManager,
  SettingsManager, type AgentSession, type ResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { UIClient, type JsonPatch } from "../client.js";
import type { ChatMessage, ChatPart, Mode, Place } from "../protocol.js";
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
  const saved: Saved = { messages, made: [...made], records: ui.records(), session: sessionFile, allowAll };
  writeFileSync(`${savedFile}.new`, JSON.stringify(saved));
  renameSync(`${savedFile}.new`, savedFile);
}

load();

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
  // Closing an approval card is declining it.
  approvals.get(id)?.("deny", true);
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
- Interfaces work on their own with setState/pushState/removeState (tabs, toggles, adding and ticking items). For anything that needs you (searching, computing, fetching, deciding), bind a button to {"action":"ask","params":{"text":"what to do"}}: you then get a message with the interface's whole state, and can update it.
- Keep interfaces compact (about 360 px wide), with a clear title and few words. One root element (usually a Card or Stack).

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
      reply = { ...reply, parts: [...settledParts, ...partsOf(message.content ?? [], false)] };
      publishReply();
      return;
    }
    case "message_end": {
      const message = event.message as { role?: string; content?: unknown[]; stopReason?: string; errorMessage?: string };
      if (message.role !== "assistant") return;
      settledParts = [...settledParts, ...partsOf(message.content ?? [], true)];
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
        part.type === "tool" && part.id === event.toolCallId
          ? { ...part, status: done ? (failed ? "error" : "done") : "running" } : part);
      reply = { ...reply, parts: settledParts };
      publishReply(true);
      return;
    }
  }
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
        ? `Shown (${where}), with problems to fix by another ui_render call with id "${params.id}":\n- ${problems.join("\n- ")}${stays}`
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
      const answer: Answer = allowAll ? "run" : await approve(command, signal);
      if (answer === "deny") return text("The person did not allow this command. Ask them, or do without it.");
      if (answer === "always") allowAll = true;
      return bash.execute(callId, params as never, signal, onUpdate as never, context);
    },
  } as ToolDefinition;
  return [render, place, close, read, askedBash, createReadToolDefinition(home), createLsToolDefinition(home),
          createGrepToolDefinition(home), createFindToolDefinition(home)] as ToolDefinition[];
}

/** The approval card's buttons, once ANSWER is given: what was decided, in their place. */
function decision(answer: Answer): JsonPatch {
  return { op: "replace", path: "/elements/buttons", value: { type: "Text", children: [], props: {
    text: answer === "deny" ? "Not run." : answer === "always" ? "Ran · commands run freely for the rest of this chat." : "Ran.",
    tone: answer === "deny" ? "muted" : "success", size: "sm" } } };
}

/** Ask the person, on a card in the chat, whether COMMAND may run. Closing the card, or stopping, declines. */
function approve(command: string, signal: AbortSignal | undefined): Promise<Answer> {
  const id = nextId("approve-");
  const message = reply?.id;
  if (!message) return Promise.resolve("deny");
  settledParts = [...settledParts, { type: "ui", id }];
  reply = { ...reply!, parts: settledParts };
  made.set(id, { title: "Run a command?", mode: "inline", message, approval: "pending" });
  void ui.open(id, {
    mode: "inline", title: "Run a command?", message,
    spec: {
      root: "card", state: {},
      elements: {
        card: { type: "Stack", props: { gap: "md" }, children: ["code", "buttons"] },
        code: { type: "Code", props: { text: command }, children: [] },
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
