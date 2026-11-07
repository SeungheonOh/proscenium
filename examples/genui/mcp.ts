// An MCP server that lets coding agents (Claude Code, Codex, anything that
// speaks MCP) put interfaces of their own on the person's screen and hear back:
// a question with answers to pick, or any interface they design from the catalog
// (a form, a list to triage, a review), which they wait on like a dialog. The
// interfaces are this process's, so they close when the agent's session ends.
//
//     claude --mcp-config '{"mcpServers":{"proscenium":{"command":"…/scripts/proscenium-mcp"}}}'
//     codex: [mcp_servers.proscenium] command = "…/scripts/proscenium-mcp", tool_timeout_sec = 3600
//
// MCP over stdio is JSON-RPC, one message a line; nothing to install.

import { UIClient, type JsonPatch, type Mode, type Spec } from "./client.js";
import type { HostMessage } from "./protocol.js";

type Json = Record<string, unknown>;

interface Event {
  id: string;
  kind: "action" | "closed";
  action?: string;
  params?: Json;
  state?: Json;
}

let ui: UIClient | undefined;
let agentName = "Agent";
const open = new Set<string>();
/** The state each interface was given, top-level key by key: what comes back unchanged need not be sent again. */
const given = new Map<string, Json>();
const queued: Event[] = [];
const waiters: { id?: string; resolve: (event: Event | null) => void }[] = [];
let asked = 0;

function connect(): UIClient {
  if (ui) return ui;
  ui = new UIClient({ name: agentName });
  ui.on("action", ({ id, action, params, state }) => heard({ id, kind: "action", action, params, state }));
  ui.on("closed", ({ id, by }: Extract<HostMessage, { type: "closed" }>) => {
    if (!open.delete(id)) return;
    if (by === "person") heard({ id, kind: "closed" });
  });
  return ui;
}

/** The world, connected: the first call waits a moment for it. */
async function world(): Promise<UIClient> {
  const client = connect();
  for (let waited = 0; !client.isConnected && waited < 3000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!client.isConnected) throw new Error("No Proscenium world is listening");
  return client;
}

function heard(event: Event): void {
  const at = waiters.findIndex((waiter) => waiter.id === undefined || waiter.id === event.id);
  if (at >= 0) waiters.splice(at, 1)[0]!.resolve(event);
  else queued.push(event);
}

/** The next thing the person does in interface ID (any, without one), or null after SECONDS. */
function next(id: string | undefined, seconds: number): Promise<Event | null> {
  const at = queued.findIndex((event) => id === undefined || event.id === id);
  if (at >= 0) return Promise.resolve(queued.splice(at, 1)[0]!);
  return new Promise((resolve) => {
    const waiter = { id, resolve: (event: Event | null) => { clearTimeout(timer); resolve(event); } };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      resolve(null);
    }, seconds * 1000);
    waiters.push(waiter);
  });
}

/** The state a show_interface call gives its interface: its spec's, or what its patches put under /state. */
function stateOf(args: Json): Json {
  const spec = args.spec as { state?: Json } | undefined;
  const state: Json = { ...(spec?.state ?? {}) };
  for (const patch of Array.isArray(args.patches) ? args.patches as JsonPatch[] : []) {
    if (patch.op === "remove") continue;
    if (patch.path === "/state" && patch.value && typeof patch.value === "object") Object.assign(state, patch.value);
    const key = /^\/state\/([^/]+)$/.exec(patch.path)?.[1];
    if (key) state[key.replace(/~1/g, "/").replace(/~0/g, "~")] = (patch as { value?: unknown }).value;
  }
  return state;
}

/** What the person did, for the model: the action, its params and what the interface holds now (its own /_ui left out). */
function told(event: Event | null): string {
  if (!event) return "The person has not answered yet. Call wait_for_person again to keep waiting.";
  if (event.kind === "closed") return `The person closed "${event.id}" without answering.`;
  const { _ui: _, ...state } = event.state ?? {};
  // A long value the person left as it was (a diff, a document) is not worth its tokens a second time.
  const sent = given.get(event.id) ?? {};
  const unchanged: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    const text = JSON.stringify(value);
    if (text.length > 200 && text === JSON.stringify(sent[key])) {
      delete state[key];
      unchanged.push(key);
    }
  }
  return JSON.stringify({ interface: event.id, action: event.action, params: event.params, state,
                          ...(unchanged.length ? { unchanged } : {}) }, null, 1);
}

const modes = ["floating", "overlay", "dock", "canvas", "dialog"];

const tools = [
  {
    name: "ask_person",
    description: "Ask the person at the computer a question in a card on their screen and wait for the answer. Use it for a decision only they can make, when the answers need explaining, or when they may be away from the terminal. Give choices for them to pick from (each with a short description, one marked recommended in its description if you have a view); they can always answer in their own words instead. Returns their choice and anything they wrote.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, one sentence." },
        details: { type: "string", description: "Markdown under the question: what you found, what each answer means. Optional." },
        choices: {
          type: "array", description: "Answers to pick from. Optional: without them it asks for a written answer.",
          items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
        },
        multiple: { type: "boolean", description: "Several choices may be picked." },
        title: { type: "string", description: "The card's title, a few words." },
      },
      required: ["question"],
    },
  },
  {
    name: "show_interface",
    description: "Put an interface you design on the person's screen, drawn natively: a form to fill in, a list to triage with a control per item, a review to approve, a live status board. Call interface_components first to learn the components and the spec format. Buttons whose press should come back to you use an action of your own naming, e.g. {\"on\":{\"press\":{\"action\":\"submit\"}}}; with wait: true this returns the first such action with the interface's whole state (what the person typed, picked, toggled), otherwise call wait_for_person. Calling it again with the same id replaces that interface. It stays open until you close it (close_interface) or the person does: once you have the answer, close it or update it to show what happened.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Your name for it, to update, wait on or close it." },
        title: { type: "string" },
        spec: { type: "object", description: "The whole spec: { root, elements, state }." },
        patches: { type: "array", description: "Or JSON patches building the spec, as interface_components describes.", items: { type: "object" } },
        mode: { type: "string", enum: modes, description: "floating (a card, the default), overlay (pinned over everything in a corner), dock (a panel at the side), canvas (in the world with the windows), dialog (centred, everything else dimmed until answered)." },
        width: { type: "number", description: "Pixels; 360 by default." },
        wait: { type: "boolean", description: "Wait for the person's first action (or for them to close it) before returning." },
      },
      required: ["id"],
    },
  },
  {
    name: "update_interface",
    description: "Change an interface you showed: set state by JSON pointer ({\"/progress\": 0.5, \"/items/2/done\": true}), or apply JSON patches to its spec (/elements/KEY, /state/PATH).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        state: { type: "object", description: "JSON pointer → new value." },
        patches: { type: "array", items: { type: "object" } },
      },
      required: ["id"],
    },
  },
  {
    name: "wait_for_person",
    description: "Wait for the person's next action in an interface you showed (or in any, without an id): its action name, params and the interface's state. Returns early with nothing if they take longer than timeout_seconds.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, timeout_seconds: { type: "number", description: "600 by default." } },
    },
  },
  {
    name: "close_interface",
    description: "Close an interface you showed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "notify_person",
    description: "A short note over everything in a corner of the person's screen for a few seconds: something finished, something needs a look. Markdown.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, title: { type: "string" }, seconds: { type: "number" } },
      required: ["text"],
    },
  },
  {
    name: "interface_components",
    description: "How to write interfaces for show_interface: the components the screen draws (text, tables, charts, forms, choices, diffs, steps…), their props, state, bindings and actions.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function call(name: string, args: Json): Promise<string> {
  switch (name) {
    case "ask_person":
      return askPerson(args);
    case "show_interface": {
      const client = await world();
      const id = String(args.id ?? "");
      if (!id) throw new Error("show_interface needs an id");
      const mode = modes.includes(String(args.mode)) ? args.mode as Mode : "floating";
      const result = await client.open(id, {
        mode, title: args.title ? String(args.title) : undefined, width: typeof args.width === "number" ? args.width : undefined,
        spec: args.spec as Partial<Spec> | undefined, patches: args.patches as JsonPatch[] | undefined,
        place: mode === "overlay" ? { anchor: "top-right" } : mode === "dock" ? { side: "right" } : undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "It did not open");
      open.add(id);
      given.set(id, stateOf(args));
      const problems = result.problems?.length ? `Problems to fix: ${result.problems.join("; ")}` : "";
      if (args.wait === true) return [problems, told(await next(id, 3600))].filter(Boolean).join("\n");
      return problems || `Showing "${id}". Call wait_for_person to hear what the person does.`;
    }
    case "update_interface": {
      const client = await world();
      const id = String(args.id ?? "");
      if (!open.has(id)) throw new Error(`No interface "${id}" is open`);
      const problems: string[] = [];
      if (args.state && typeof args.state === "object") {
        const set = Object.fromEntries(Object.entries(args.state as Json).map(([key, value]) => [key.startsWith("/") ? key : `/${key}`, value]));
        client.state(id, set);
      }
      if (Array.isArray(args.patches)) problems.push(...((await client.patch(id, args.patches as JsonPatch[])).problems ?? []));
      return problems.length ? `Problems to fix: ${problems.join("; ")}` : "Updated.";
    }
    case "wait_for_person":
      await world();
      return told(await next(args.id ? String(args.id) : undefined, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 600));
    case "close_interface": {
      const client = await world();
      const id = String(args.id ?? "");
      client.close(id);
      open.delete(id);
      return "Closed.";
    }
    case "notify_person": {
      const client = await world();
      const id = `note-${++asked}`;
      await client.open(id, { mode: "overlay", place: { anchor: "top-right" }, title: args.title ? String(args.title) : agentName,
                              width: 320, spec: { root: "text", elements: { text: { type: "Markdown", props: { text: String(args.text ?? "") }, children: [] } } } });
      setTimeout(() => client.close(id), Math.min(Math.max(Number(args.seconds) || 6, 2), 60) * 1000);
      return "Shown.";
    }
    case "interface_components": {
      const client = await world();
      return (await client.catalog()).prompt?.replace(/ui_render/g, "show_interface") ?? "";
    }
    default:
      throw new Error(`No tool "${name}"`);
  }
}

/** A question card: the question, what it is about, answers to pick and room for the person's own. */
async function askPerson(args: Json): Promise<string> {
  const client = await world();
  const id = `ask-${++asked}`;
  const choices = (Array.isArray(args.choices) ? args.choices : []).map((choice) =>
    typeof choice === "string" ? { label: choice } : { label: String((choice as Json).label ?? ""), description: (choice as Json).description ? String((choice as Json).description) : null });
  const multiple = args.multiple === true;
  const children = ["question", ...(args.details ? ["details"] : []), ...(choices.length ? ["choices"] : []), "own", "buttons"];
  const result = await client.open(id, {
    mode: "overlay", place: { anchor: "top-right" }, title: args.title ? String(args.title) : "Question", width: 420,
    spec: {
      root: "root",
      state: { choice: multiple ? [] : null, own: "", missing: false },
      elements: {
        root: { type: "Stack", props: { gap: "md" }, children: [...children.slice(0, -1), "missing", "buttons"] },
        question: { type: "Heading", props: { text: String(args.question ?? ""), level: 2 }, children: [] },
        details: { type: "Markdown", props: { text: String(args.details ?? "") }, children: [] },
        choices: { type: "Choices", props: { options: choices, multiple, value: { $bindState: "/choice" } }, children: [] },
        own: { type: "TextField", props: { value: { $bindState: "/own" }, placeholder: choices.length ? "Or answer in your own words" : "Your answer",
                                           multiline: !choices.length }, children: [], on: { submit: { action: "answer" } } },
        missing: { type: "Text", props: { text: choices.length ? "Pick an answer or write one." : "Write an answer first.", tone: "danger", size: "sm" },
                   children: [], visible: { $state: "/missing" } },
        buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm", justify: "end" }, children: ["skip", "answer"] },
        skip: { type: "Button", props: { label: "Not now" }, children: [], on: { press: { action: "skip" } } },
        answer: { type: "Button", props: { label: "Answer", variant: "filled" }, children: [], on: { press: { action: "answer" } } },
      },
    } as Partial<Spec>,
  });
  if (!result.ok) throw new Error(result.error ?? "It did not open");
  open.add(id);
  try {
    for (;;) {
      const event = await next(id, 24 * 3600);
      if (!event || event.kind === "closed") return "The person closed the question without answering.";
      if (event.action === "skip") return "The person chose not to answer now.";
      if (event.action !== "answer") continue;
      const picked = event.state?.choice;
      const chosen = Array.isArray(picked) ? picked.map(String) : picked ? [String(picked)] : [];
      const own = String(event.state?.own ?? "").trim();
      if (!chosen.length && !own) {
        client.state(id, { "/missing": true });
        continue;
      }
      return [chosen.length ? `Chose: ${chosen.map((each) => `"${each}"`).join(", ")}` : "", own ? `Wrote: ${own}` : ""].filter(Boolean).join("\n");
    }
  } finally {
    client.close(id);
    open.delete(id);
  }
}

// JSON-RPC over stdio.

function reply(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(message: Json): Promise<void> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined) return; // A notification: initialized, cancelled.
  try {
    switch (method) {
      case "initialize": {
        const client = String((params.clientInfo as Json | undefined)?.name ?? "");
        agentName = /claude/i.test(client) ? "Claude Code" : /codex/i.test(client) ? "Codex" : client || "Agent";
        connect();
        return reply({ id, result: {
          protocolVersion: String(params.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: "proscenium", version: "1.0.0" },
          instructions: "These tools put cards and interfaces on the person's screen in Proscenium and wait for what they do there. Prefer ask_person for a question; show_interface for anything richer (call interface_components first).",
        } });
      }
      case "ping":
        return reply({ id, result: {} });
      case "tools/list":
        return reply({ id, result: { tools } });
      case "tools/call": {
        try {
          const text = await call(String(params.name), (params.arguments ?? {}) as Json);
          return reply({ id, result: { content: [{ type: "text", text }] } });
        } catch (error) {
          return reply({ id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });
        }
      }
      default:
        return reply({ id, error: { code: -32601, message: `No method ${String(method)}` } });
    }
  } catch (error) {
    reply({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as Json);
    } catch {
      reply({ id: null, error: { code: -32700, message: "Not JSON" } });
    }
  }
});
// The agent's session ended: its interfaces go with this process.
process.stdin.on("end", () => process.exit(0));
