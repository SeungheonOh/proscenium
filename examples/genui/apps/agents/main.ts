// Agents: what the coding agents on this machine are doing, and what they need
// from the person. Claude Code and Codex run hook.mjs (beside this) on their
// hooks, which tells this app each moment of theirs. It keeps a panel of their
// sessions (the project, the latest prompt, what runs now, the plan) and opens a
// card over everything for each request: a command or an edit to allow, Claude's
// questions to answer. The hook waits for the answer and hands it back, and the
// agent goes on. A card closed unanswered leaves the question to the terminal.
//
// Started by the first hook that tells it something; it quits once no agent is
// left to show.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { app, type Element, type View } from "proscenium-app";

type Agent = "claude" | "codex";

interface Suggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  mode?: string;
  directories?: string[];
  behavior?: string;
  destination?: string;
}

interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string | null;
  permission_suggestions?: Suggestion[];
}

interface Step {
  id?: string;
  title: string;
  status: string;
  detail?: string;
}

interface Session {
  key: string;
  agent: Agent;
  cwd: string;
  prompt?: string;
  /** Working on a prompt, waiting for its next one, or gone. */
  status: "working" | "idle" | "ended";
  activity?: string;
  plan: Step[];
  /** Requests waiting for the person. */
  asks: number;
  /** In a tool of ours that waits for the person: its own interface, a question. */
  waiting: boolean;
  /** When its turn began, and when anything last happened. */
  turnAt: number;
  updated: number;
}

const names: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
const sessions = new Map<string, Session>();
const ui = app({ title: "Agents" });
let panel: View | undefined;
let asks = 0;

ui.onMessage(async (message, told) => {
  const { agent, event } = (message ?? {}) as { agent?: Agent; event?: HookEvent };
  if (!event?.hook_event_name || (agent !== "claude" && agent !== "codex")) return null;
  const session = sessionOf(agent, event);
  session.updated = Date.now();
  switch (event.hook_event_name) {
    case "SessionStart":
      break;
    case "UserPromptSubmit":
      // The agent's own notes to itself (a background task finished) are not the person's prompt.
      if (event.prompt?.trimStart().startsWith("<")) break;
      session.prompt = event.prompt?.trim() || session.prompt;
      session.status = "working";
      session.activity = "Thinking";
      session.turnAt = Date.now();
      break;
    case "PreToolUse":
      if (event.tool_name === "AskUserQuestion") return await request(session, event, told.signal);
      session.status = "working";
      session.activity = activityOf(event) ?? session.activity;
      session.waiting = waitsForPerson(event);
      break;
    case "PostToolUse":
      if (waitsForPerson(event)) session.waiting = false;
      followPlan(session, event);
      break;
    case "PermissionRequest":
      return await request(session, event, told.signal);
    case "Stop":
      session.waiting = false;
      finished(session, event);
      break;
    case "SessionEnd":
      session.status = "ended";
      session.activity = undefined;
      setTimeout(() => {
        if (sessions.get(session.key)?.status === "ended") {
          sessions.delete(session.key);
          show();
        }
      }, 20_000);
      break;
  }
  show();
  return null;
});

// Asked for from the chat or the shell: the panel, if any agent is about.
ui.onShow(() => show());

// A session that has said nothing for an hour (its agent was killed, with no SessionEnd) is gone.
setInterval(() => {
  const before = sessions.size;
  for (const [key, session] of sessions) if (session.asks === 0 && Date.now() - session.updated > 3600_000) sessions.delete(key);
  if (sessions.size !== before) show();
}, 60_000).unref();

function sessionOf(agent: Agent, event: HookEvent): Session {
  const key = `${agent}:${event.session_id ?? event.cwd ?? "?"}`;
  let session = sessions.get(key);
  if (!session) {
    // The same agent started again in the same folder: the idle session it left (killed, with no SessionEnd) is gone.
    for (const [other, left] of sessions) {
      if (left.agent === agent && left.cwd === event.cwd && left.status !== "working" && left.asks === 0) sessions.delete(other);
    }
    session = { key, agent, cwd: event.cwd ?? "", status: "idle", plan: [], asks: 0, waiting: false, turnAt: Date.now(),
                updated: Date.now() };
    sessions.set(key, session);
  }
  if (event.cwd) session.cwd = event.cwd;
  return session;
}

const project = (session: Session) => basename(session.cwd) || session.cwd || "?";
const short = (value: string, length: number) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};
const fileName = (input: Record<string, unknown> | undefined) => basename(String(input?.file_path ?? input?.path ?? input?.notebook_path ?? ""));

/** Whether a tool waits for the person: the MCP server's questions and interfaces (scripts/proscenium-mcp). */
function waitsForPerson(event: HookEvent): boolean {
  const tool = /^mcp__.+?__(.+)$/.exec(event.tool_name ?? "")?.[1];
  return tool === "ask_person" || tool === "wait_for_person" || (tool === "show_interface" && event.tool_input?.wait === true);
}

/** What a tool starting means, in a few words. */
function activityOf(event: HookEvent): string | undefined {
  const input = event.tool_input ?? {};
  const tool = event.tool_name ?? "";
  switch (tool) {
    case "Bash":
    case "shell":
    case "exec_command":
      return `Running ${short(commandOf(input), 48)}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "apply_patch":
      return `Editing ${fileName(input) || "files"}`;
    case "Write":
      return `Writing ${fileName(input)}`;
    case "Read":
      return `Reading ${fileName(input)}`;
    case "Grep":
    case "Glob":
      return `Searching for ${short(String(input.pattern ?? ""), 32)}`;
    case "WebFetch":
      return `Reading ${hostOf(String(input.url ?? ""))}`;
    case "WebSearch":
      return `Searching the web for “${short(String(input.query ?? ""), 36)}”`;
    case "Task":
    case "Agent":
      return `Running a subagent: ${short(String(input.description ?? ""), 36)}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
    case "ToolSearch":
      return undefined;
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      return mcp ? `Using ${mcp[2]!.replace(/_/g, " ")}` : `Using ${tool}`;
    }
  }
}

function commandOf(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd;
  return Array.isArray(command) ? command.join(" ") : String(command ?? "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The plan, as the agent's task tools change it: Claude's TodoWrite list, or its tasks one by one. */
function followPlan(session: Session, event: HookEvent): void {
  const input = event.tool_input ?? {};
  const response = (event.tool_response ?? {}) as Record<string, unknown>;
  switch (event.tool_name) {
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos as Record<string, unknown>[] : [];
      session.plan = todos.map((todo) => ({ title: String(todo.content ?? ""), status: String(todo.status ?? "pending") }));
      const active = todos.find((todo) => todo.status === "in_progress");
      if (active?.activeForm) session.activity = String(active.activeForm);
      return;
    }
    case "TaskCreate": {
      const task = (response.task ?? response) as Record<string, unknown>;
      session.plan.push({ id: String(task.id ?? task.taskId ?? session.plan.length + 1), title: String(input.subject ?? input.title ?? ""),
                          status: "pending" });
      return;
    }
    case "TaskUpdate": {
      const step = session.plan.find((each) => each.id === String(input.taskId ?? input.id ?? ""));
      if (!step) return;
      if (input.status) step.status = String(input.status);
      if (input.subject) step.title = String(input.subject);
      if (step.status === "in_progress" && input.activeForm) session.activity = String(input.activeForm);
      if (step.status === "deleted") session.plan = session.plan.filter((each) => each !== step);
      return;
    }
  }
}

/** A turn ended: the session waits for the person, with a note if the turn was long enough to look away from. */
function finished(session: Session, event: HookEvent): void {
  session.status = "idle";
  session.activity = undefined;
  const took = Date.now() - session.turnAt;
  const said = event.last_assistant_message?.trim();
  if (took > 20_000 && said) {
    ui.notify(short(said.split("\n").find((line) => line.trim()) ?? said, 180),
              { title: `${names[session.agent]} finished · ${project(session)}`, seconds: 8 });
  }
}

// The panel: every session, newest first.

const statusBadge = (session: Session) =>
  session.asks > 0 || session.waiting ? { text: "Needs you", tone: "warning" }
    : session.status === "working" ? { text: "Working", tone: "accent" }
    : session.status === "ended" ? { text: "Ended", tone: "muted" }
    : { text: "Your turn", tone: "success" };

function show(): void {
  const shown = [...sessions.values()].sort((a, b) => b.updated - a.updated);
  ui.background = asks > 0;
  if (!shown.length) {
    panel?.close();
    panel = undefined;
    return;
  }
  const elements: Record<string, Element> = {};
  const add = (key: string, type: string, props: Record<string, unknown>, children: string[] = []) => {
    elements[key] = { type, props, children } as Element;
    return key;
  };
  const rows = shown.flatMap((session, index) => {
    const at = `s${index}`;
    const badge = statusBadge(session);
    const parts = [
      add(`${at}-head`, "Stack", { direction: "horizontal", gap: "sm", align: "center" }, [
        add(`${at}-name`, "Text", { text: project(session), weight: "bold", maxLines: 1 }),
        add(`${at}-agent`, "Text", { text: names[session.agent], tone: "muted", size: "sm", maxLines: 1 }),
        add(`${at}-gap`, "Spacer", {}),
        add(`${at}-status`, "Badge", badge),
      ]),
    ];
    if (session.prompt) parts.push(add(`${at}-prompt`, "Text", { text: `“${short(session.prompt, 140)}”`, size: "sm", maxLines: 2 }));
    if (session.activity && session.status === "working") {
      const needed = session.asks > 0 || session.waiting;
      parts.push(add(`${at}-activity`, "Text", { text: needed ? "Waiting for you" : session.activity,
                                                 tone: needed ? "warning" : "accent", size: "sm", maxLines: 1 }));
    }
    if (session.plan.length) parts.push(add(`${at}-plan`, "Steps", { items: session.plan }));
    const block = add(at, "Stack", { gap: "sm" }, parts);
    return index === 0 ? [block] : [add(`${at}-rule`, "Divider", {}), block];
  });
  add("root", "Stack", { gap: "md" }, rows);
  const spec = { root: "root", elements };
  if (panel?.open) panel.patch([{ op: "add", path: "/elements", value: elements }, { op: "replace", path: "/root", value: "root" }]);
  else {
    panel = ui.open("agents", { mode: "dock", place: { side: "right" }, title: "Agents", width: 330, spec });
    panel.onClose(() => (panel = undefined));
  }
}

// Requests: a card for each, answered there.

type Decision = Record<string, unknown> | null;

/** Ask the person what EVENT wants, in a card over everything, and give the hook its answer (null: ask in the terminal). */
async function request(session: Session, event: HookEvent, signal: AbortSignal): Promise<Decision> {
  // The proscenium MCP server's tools only put things on this screen, where the person answers anyway:
  // asking whether the agent may ask is noise.
  if (event.hook_event_name === "PermissionRequest" && /^mcp__proscenium__/.test(event.tool_name ?? "")) {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  }
  const id = `ask-${Date.now().toString(36)}-${(asks + Math.random()).toString(36).slice(2, 6)}`;
  const question = event.tool_name === "AskUserQuestion" && event.hook_event_name === "PreToolUse";
  const card = question ? questionCard(event) : permissionCard(session, event);
  session.asks++;
  asks++;
  session.status = "working";
  show();
  try {
    return await new Promise<Decision>((resolve) => {
      const view = ui.open(id, { mode: "overlay", place: { anchor: "top-right" }, title: `${names[session.agent]} · ${project(session)}`,
                                 width: card.width, spec: card.spec });
      const done = (decision: Decision) => {
        resolve(decision);
        view.close();
      };
      // The agent stopped asking (the person pressed Esc there, or it was interrupted): the card goes.
      signal.addEventListener("abort", () => done(null));
      view.onClose(() => resolve(null));
      card.wire(view, done);
    });
  } finally {
    session.asks--;
    asks--;
    session.updated = Date.now();
    show();
  }
}

interface Card {
  width: number;
  spec: { root: string; state?: Record<string, unknown>; elements: Record<string, Element> };
  wire(view: View, done: (decision: Decision) => void): void;
}

const button = (label: string, action: string, variant = "plain"): Element =>
  ({ type: "Button", props: { label, variant }, children: [], on: { press: { action } } }) as Element;
const text = (value: string, props: Record<string, unknown> = {}): Element =>
  ({ type: "Text", props: { text: value, ...props }, children: [] }) as Element;

/** What allowing a request once more, always, would add: in words for its button. */
function alwaysLabel(suggestion: Suggestion | undefined): string | undefined {
  if (!suggestion) return undefined;
  if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") return "Allow all edits";
  if (suggestion.type === "addDirectories") return "Allow this folder";
  const rule = suggestion.rules?.[0];
  if (suggestion.type === "addRules" && rule) {
    if (rule.toolName.startsWith("mcp__")) return "Always allow this tool";
    if (!rule.ruleContent) return `Always allow ${short(rule.toolName, 20)}`;
    return `Always allow ${short(rule.ruleContent.replace(/:\*$/, " …"), 28)}`;
  }
  return "Always allow";
}

/** A permission: what the tool would do, shown as it is (a command, a diff), and Allow, Deny or Always. */
function permissionCard(session: Session, event: HookEvent): Card {
  const agentName = names[session.agent];
  const input = event.tool_input ?? {};
  const tool = event.tool_name ?? "a tool";
  const suggestion = session.agent === "claude" ? event.permission_suggestions?.[0] : undefined;
  const always = alwaysLabel(suggestion);
  const body: Record<string, Element> = {};
  let headline: string;
  let width = 420;
  switch (tool) {
    case "Bash":
    case "shell":
    case "exec_command": {
      headline = "Run this command?";
      // A long one (a heredoc, a script) shows its start: the card fits on the screen.
      const lines = commandOf(input).split("\n");
      const room = Math.max(6, Math.floor((ui.screen.height - 330) / 17));
      body.command = { type: "Code", props: { text: lines.slice(0, room).join("\n") }, children: [] } as Element;
      if (lines.length > room) body.more = text(`${lines.length - room} more lines`, { tone: "muted", size: "sm" });
      if (input.description) body.why = text(String(input.description), { tone: "muted", size: "sm" });
      break;
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const path = String(input.file_path ?? "");
      const change = editOf(tool, input);
      headline = tool === "Write" ? (change.existed ? `Overwrite ${basename(path)}?` : `Create ${basename(path)}?`) : `Edit ${basename(path)}?`;
      body.diff = { type: "Diff", props: { before: change.before, after: change.after, startLine: change.startLine,
                                           path: path.startsWith(session.cwd + "/") ? path.slice(session.cwd.length + 1) : path,
                                           maxLines: diffRoom() }, children: [] } as Element;
      width = 520;
      break;
    }
    case "apply_patch": {
      const patch = String(input.patch ?? input.input ?? input.command ?? "");
      const files = patch.match(/^\*\*\* (Update|Add|Delete) File: /gm)?.length ?? 1;
      headline = files === 1 ? "Change this file?" : `Change these ${files} files?`;
      body.diff = { type: "Diff", props: { patch: codexPatch(patch, session.cwd), maxLines: diffRoom() },
                    children: [] } as Element;
      width = 520;
      break;
    }
    case "WebFetch": {
      headline = `Read ${hostOf(String(input.url ?? ""))}?`;
      body.url = { type: "Code", props: { text: String(input.url ?? "") }, children: [] } as Element;
      if (input.prompt) body.why = text(short(String(input.prompt), 200), { tone: "muted", size: "sm" });
      break;
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      headline = mcp ? `Use ${mcp[2]!.replace(/_/g, " ")} from ${mcp[1]!.replace(/_/g, " ")}?` : `Use ${tool}?`;
      if (Object.keys(input).length) {
        body.input = { type: "Code", props: { text: short(JSON.stringify(input, null, 1), 600), maxLines: 12 }, children: [] } as Element;
      }
    }
  }
  const actions = ["deny", ...(always ? ["always"] : []), "allow"];
  const elements: Record<string, Element> = {
    root: { type: "Stack", props: { gap: "md" }, children: ["headline", ...Object.keys(body), "instead", "buttons"] } as Element,
    headline: { type: "Heading", props: { text: headline, level: 2 }, children: [] } as Element,
    ...body,
    instead: { type: "TextField", props: { value: { $bindState: "/instead" }, placeholder: `Or tell ${agentName.split(" ")[0]} what to do instead` },
               children: [], on: { submit: { action: "deny" } } } as Element,
    buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm", justify: "end" }, children: actions } as Element,
    deny: button("Deny", "deny"),
    allow: button("Allow", "allow", "filled"),
  };
  if (always) elements.always = button(always, "always", "tinted");
  return {
    width,
    spec: { root: "root", state: { instead: "" }, elements },
    wire(view, done) {
      const decide = (decision: Record<string, unknown>) =>
        done({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
      view.on("allow", () => decide({ behavior: "allow" }));
      view.on("always", () => decide({ behavior: "allow", updatedPermissions: [suggestion] }));
      view.on("deny", () => {
        const instead = String(view.get("/instead") ?? "").trim();
        decide({ behavior: "deny", message: instead || "The person denied this." });
      });
    },
  };
}

/** Diff lines that fit on the screen with the card's heading, field and buttons. */
const diffRoom = () => Math.min(60, Math.max(10, Math.floor((ui.screen.height - 420) / 18)));

/** The text an edit changes, around where it changes it, numbered from its place in the file. */
function editOf(tool: string, input: Record<string, unknown>): { before: string; after: string; startLine: number; existed: boolean } {
  const path = String(input.file_path ?? "");
  let file: string | undefined;
  try {
    file = readFileSync(path, "utf8");
  } catch {}
  let after: string;
  const replace = (text: string, edit: Record<string, unknown>) => {
    const old = String(edit.old_string ?? "");
    const next = String(edit.new_string ?? "");
    if (!old) return next + text;
    return edit.replace_all ? text.split(old).join(next) : text.replace(old, () => next);
  };
  if (tool === "Write") after = String(input.content ?? "");
  else if (file === undefined) {
    // A file it cannot read: the edit's own text, as it is.
    const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [input];
    return { before: edits.map((edit) => String(edit.old_string ?? "")).join("\n"),
             after: edits.map((edit) => String(edit.new_string ?? "")).join("\n"), startLine: 1, existed: false };
  } else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    after = (input.edits as Record<string, unknown>[]).reduce(replace, file);
  } else {
    after = replace(file, input);
  }
  const before = file ?? "";
  // Only the lines that change, and three on each side: the diff folds the rest.
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const from = Math.max(0, start - 3);
  return { before: a.slice(from, Math.min(a.length, a.length - end + 3)).join("\n"),
           after: b.slice(from, Math.min(b.length, b.length - end + 3)).join("\n"), startLine: from + 1, existed: file !== undefined };
}

/**
 * Codex's patch format (*** Update File: PATH, then @@ chunks with no line
 * numbers) as a unified diff the Diff draws, its paths from the project's folder.
 */
function codexPatch(patch: string, cwd: string): string {
  if (!patch.includes("*** Begin Patch")) return patch;
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file) {
      const path = cwd && file[2]!.startsWith(`${cwd}/`) ? file[2]!.slice(cwd.length + 1) : file[2]!;
      out.push(`diff --git a/${path} b/${path}`, `--- ${file[1] === "Add" ? "/dev/null" : `a/${path}`}`,
               `+++ ${file[1] === "Delete" ? "/dev/null" : `b/${path}`}`, "@@");
      continue;
    }
    if (line.startsWith("***")) continue;
    out.push(line);
  }
  return out.join("\n");
}

interface Question {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Claude's questions (AskUserQuestion), each with its answers to pick and room for one of the person's own. */
function questionCard(event: HookEvent): Card {
  const questions = (Array.isArray(event.tool_input?.questions) ? event.tool_input.questions : []) as Question[];
  const elements: Record<string, Element> = {};
  const keys: string[] = [];
  questions.forEach((question, index) => {
    const parts = [`q${index}-text`, `q${index}-choices`, `q${index}-other`];
    elements[`q${index}-text`] = { type: "Heading", props: { text: question.question, level: questions.length === 1 ? 2 : 3 },
                                   children: [] } as Element;
    elements[`q${index}-choices`] = {
      type: "Choices", children: [],
      props: { value: { $bindState: `/answers/${index}` }, multiple: question.multiSelect === true,
               options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? null })) },
    } as Element;
    elements[`q${index}-other`] = { type: "TextField", children: [],
                                    props: { value: { $bindState: `/other/${index}` }, placeholder: "Or answer in your own words" } } as Element;
    if (question.header) {
      elements[`q${index}-header`] = { type: "Badge", props: { text: question.header, tone: "accent" }, children: [] } as Element;
      parts.unshift(`q${index}-header`);
    }
    elements[`q${index}`] = { type: "Stack", props: { gap: "sm" }, children: parts } as Element;
    keys.push(`q${index}`);
    if (index < questions.length - 1) {
      elements[`q${index}-rule`] = { type: "Divider", props: {}, children: [] } as Element;
      keys.push(`q${index}-rule`);
    }
  });
  Object.assign(elements, {
    root: { type: "Stack", props: { gap: "lg" }, children: [...keys, "missing", "buttons"] },
    missing: { type: "Text", props: { text: "Answer each question first.", tone: "danger", size: "sm" }, children: [],
               visible: { $state: "/missing" } },
    buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm", justify: "end" }, children: ["terminal", "answer"] },
    terminal: button("Answer in the terminal", "terminal"),
    answer: button("Answer", "answer", "filled"),
  });
  return {
    width: 440,
    spec: { root: "root", state: { answers: questions.map((question) => (question.multiSelect ? [] : null)),
                                   other: questions.map(() => ""), missing: false }, elements },
    wire(view, done) {
      view.on("terminal", () => done(null));
      view.on("answer", () => {
        const answers: Record<string, string> = {};
        for (const [index, question] of questions.entries()) {
          const own = String(view.get(`/other/${index}`) ?? "").trim();
          const picked = view.get(`/answers/${index}`);
          const chosen = Array.isArray(picked) ? picked.map(String).join(", ") : picked ? String(picked) : "";
          const answer = own || chosen;
          if (!answer) return view.set("/missing", true);
          answers[question.question] = answer;
        }
        done({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
                                     updatedInput: { ...event.tool_input, answers } } });
      });
    },
  };
}
