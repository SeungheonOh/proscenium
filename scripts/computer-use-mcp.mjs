#!/usr/bin/env node
/**
 * Computer use for MCP clients: carries tool calls to the running world's
 * computer-use service (examples/lib/computer-use.ts) over
 * $XDG_RUNTIME_DIR/proscenium-computer-use.sock. For Claude Code:
 *
 *   claude mcp add proscenium -- node /path/to/proscenium/scripts/computer-use-mcp.mjs
 *
 * The world shows the agent while it is connected, by PROSCENIUM_AGENT_NAME
 * (Claude unless set). Coordinates are pixels of the world's surface, whatever
 * the screen shows.
 */

import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

const path = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "proscenium-computer-use.sock");
const name = process.env.PROSCENIUM_AGENT_NAME ?? "Claude";

const point = { x: { type: "number", description: "Pixels across the surface map, from its left." },
                y: { type: "number", description: "Pixels down the surface map, from its top." } };
const tools = [
  { name: "screenshot", description: "See the world: a PNG of its whole surface map, or of just the region of it you pick, which comes back sharper. Windows lie on it wherever they are, shown on screen or not; the text lists each with its box. Take the whole map to find your way, then the part you need, before acting and after. Other agents may be working too. Every coordinate, for regions and actions, is a pixel of the whole map.",
    inputSchema: { type: "object", properties: {
      region: { type: "object", description: "The part to capture, in map pixels; the whole map if left out.",
                required: ["x", "y", "width", "height"],
                properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } } } } },
  { name: "click", description: "Move your pointer to a point of the map and click the window there, which then takes your typing. Your pointer is your own: the person's pointer and view stay put.",
    inputSchema: { type: "object", required: ["x", "y"], properties: {
      ...point,
      button: { type: "string", enum: ["left", "right", "middle"], description: "left unless given" },
      double: { type: "boolean", description: "Double-click." } } } },
  { name: "move", description: "Move your pointer to a point of the map.",
    inputSchema: { type: "object", required: ["x", "y"], properties: point } },
  { name: "drag", description: "Press the left button at one point of the map, in the window there, move to another and let go.",
    inputSchema: { type: "object", required: ["from_x", "from_y", "to_x", "to_y"], properties: {
      from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } } } },
  { name: "type", description: "Type plain ASCII text into the window you last clicked; newlines press Return.",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  { name: "key", description: "Press a key or chord in the window you last clicked, e.g. \"Return\", \"ctrl+l\", \"ctrl+shift+t\"; the world's own, like \"super+Return\" for a terminal, work too.",
    inputSchema: { type: "object", required: ["keys"], properties: { keys: { type: "string" } } } },
  { name: "draw", description: "Draw a freehand stroke on the world's paper directly, through points of the map in order. It lies on the surface under windows, so draw on bare surface. Many points make smooth curves; draw a shape as one stroke per line.",
    inputSchema: { type: "object", required: ["points"], properties: {
      points: { type: "array", minItems: 2, maxItems: 400, description: "[[x, y], ...] in map pixels.",
                items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
      color: { type: "string", description: "#rrggbb; near-black unless given." },
      width: { type: "number", description: "1 thin, 2 bold (unless given), 4 extra bold, up to 16." } } } },
  { name: "talk", description: "Hand something to another agent at the computer, by its name as the world shows it.",
    inputSchema: { type: "object", required: ["to"], properties: {
      to: { type: "string" },
      about: { type: "string", enum: ["bug", "doc", "code", "pr", "check", "chat"], description: "What it is about; chat unless given." } } } },
  { name: "scroll", description: "Scroll the window at a point of the map: positive notches down, negative up.",
    inputSchema: { type: "object", required: ["x", "y", "amount"], properties: { ...point, amount: { type: "number" } } } },
];

let socket = null;
let serial = 0;
const pending = new Map();

/** The world's service, connected and greeted once. */
function service() {
  if (socket) return socket;
  socket = new Promise((resolve, reject) => {
    const s = connect(path);
    let buffered = "";
    s.setEncoding("utf8");
    s.on("connect", () => {
      resolve(s);
      call("hello", { name }).catch(() => {});
    });
    s.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
        if (waiter) {
          pending.delete(message.id);
          if (message.ok) waiter.resolve(message);
          else waiter.reject(new Error(message.error));
        } else if (message.error) {
          for (const w of pending.values()) w.reject(new Error(message.error));
          pending.clear();
        }
      }
    });
    const gone = (error) => {
      socket = null;
      reject(error ?? new Error("The world closed computer use."));
      for (const w of pending.values()) w.reject(error ?? new Error("The world closed computer use."));
      pending.clear();
    };
    s.on("error", (error) => gone(new Error(`No world serves computer use at ${path}: ${error.message}`)));
    s.on("close", () => gone());
  });
  return socket;
}

async function call(op, args = {}) {
  const s = await service();
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    s.write(JSON.stringify({ id, op, ...args }) + "\n");
  });
}

async function run(tool, args) {
  switch (tool) {
    case "screenshot": {
      const shot = await call("screenshot", args.region ? { region: args.region } : {});
      const [x, y, width, height] = shot.region;
      const windows = shot.windows.map((w) => `- "${w.title}" (${w.app}): box at (${w.x}, ${w.y}), ${w.width}x${w.height}`);
      return [{ type: "image", data: shot.png, mimeType: "image/png" },
              { type: "text", text: [
                `Map region at (${x}, ${y}), ${width}x${height} map pixels, shown at ${shot.width}x${shot.height}: ` +
                `an image pixel (u, v) is the map's (${x} + u * ${(width / shot.width).toFixed(4)}, ${y} + v * ${(height / shot.height).toFixed(4)}).`,
                windows.length ? `Windows, topmost last:\n${windows.join("\n")}` : "No windows.",
              ].join("\n") }];
    }
    case "click": {
      const { window } = await call("click", { x: args.x, y: args.y, button: args.button ?? "left", count: args.double ? 2 : 1 });
      return [{ type: "text", text: window === null ? `Clicked (${args.x}, ${args.y}): bare surface, no window there.` : `Clicked (${args.x}, ${args.y}) in "${window}".` }];
    }
    case "move":
      await call("move", { x: args.x, y: args.y });
      return [{ type: "text", text: `Moved to (${args.x}, ${args.y}).` }];
    case "drag":
      await call("drag", { fromX: args.from_x, fromY: args.from_y, toX: args.to_x, toY: args.to_y });
      return [{ type: "text", text: "Dragged." }];
    case "type":
      await call("type", { text: args.text });
      return [{ type: "text", text: "Typed." }];
    case "key":
      await call("key", { keys: args.keys });
      return [{ type: "text", text: `Pressed ${args.keys}.` }];
    case "draw":
      await call("draw", { points: args.points, color: args.color, width: args.width });
      return [{ type: "text", text: `Drew a stroke through ${args.points.length} points.` }];
    case "talk":
      await call("talk", { to: args.to, about: args.about });
      return [{ type: "text", text: `Told ${args.to}.` }];
    case "scroll":
      await call("scroll", { x: args.x, y: args.y, dy: args.amount });
      return [{ type: "text", text: "Scrolled." }];
    default:
      throw new Error(`No tool ${tool}.`);
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const input = createInterface({ input: process.stdin });

// The client ends the server by closing its input: the agent leaves the world with it, rather than
// lingering there connected.
input.on("close", async () => {
  const s = await socket?.catch(() => null);
  s?.end();
  process.exit(0);
});

input.on("line", async (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // notifications
  try {
    switch (method) {
      case "initialize":
        send({ id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} },
                             serverInfo: { name: "proscenium-computer-use", version: "0.1.0" } } });
        break;
      case "tools/list":
        send({ id, result: { tools } });
        break;
      case "tools/call":
        try {
          send({ id, result: { content: await run(params.name, params.arguments ?? {}) } });
        } catch (error) {
          send({ id, result: { content: [{ type: "text", text: String(error.message ?? error) }], isError: true } });
        }
        break;
      case "ping":
        send({ id, result: {} });
        break;
      default:
        send({ id, error: { code: -32601, message: `No method ${method}` } });
    }
  } catch (error) {
    send({ id, error: { code: -32603, message: String(error.message ?? error) } });
  }
});
