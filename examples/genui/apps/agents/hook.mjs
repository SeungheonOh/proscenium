#!/usr/bin/env node
// A hook for coding agents, Claude Code and Codex: it hands each moment of theirs
// (a prompt, a tool starting, the plan changing, a turn ending) to the Agents app
// beside it, and for what the person has to answer (a permission, Claude's
// questions) it waits for the answer and prints it as the hook's output, so the
// agent goes on with it. With no world listening it prints nothing, and the agent
// asks in its terminal as it always does.
//
//     node hook.mjs claude|codex      (the hook's event on stdin)
//
// `proscenium-ui hooks claude|codex` prints the settings that call it. Plain
// JavaScript with nothing to bundle: agents run a hook for every tool they use.

import { createConnection } from "node:net";

const agent = process.argv[2] === "codex" ? "codex" : "claude";

const input = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => resolve(text));
});
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
// For looking at what an agent sends: every event, a line each.
if (process.env.PROSCENIUM_AGENT_HOOK_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.PROSCENIUM_AGENT_HOOK_LOG, `${JSON.stringify({ agent, ...event })}\n`);
}
const name = event?.hook_event_name;
// What waits for the person: a permission, and Claude's questions, which a hook answers before the tool runs.
const waits = name === "PermissionRequest" || (name === "PreToolUse" && event.tool_name === "AskUserQuestion");

const path = process.env.PROSCENIUM_UI_SOCKET
  || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/proscenium-ui.sock`;
const socket = createConnection(path);
socket.setEncoding("utf8");
socket.on("error", () => process.exit(0));
socket.on("close", () => process.exit(0));
socket.on("connect", () => {
  socket.write(`${JSON.stringify({ op: "hello", name: agent === "codex" ? "Codex" : "Claude Code", pid: process.pid })}\n`);
  socket.write(`${JSON.stringify({ op: "tell", app: "agents", message: { agent, event }, reply: waits, request: 1 })}\n`);
  // The world keeps what needs no answer until the app takes it.
  if (!waits) socket.end();
});
let buffered = "";
socket.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "result" || message.request !== 1) continue;
    if (message.ok && message.value) process.stdout.write(JSON.stringify(message.value));
    process.exit(0);
  }
});
