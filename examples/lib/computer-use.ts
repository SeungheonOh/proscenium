/**
 * Computer use: agents working a world the way a person does, from
 * screenshots, a pointer and the keyboard, on a surface the world lays out
 * (`AgentSurface`), wherever the view looks. The world listens on
 * $XDG_RUNTIME_DIR/proscenium-computer-use.sock, a connection an agent, for
 * newline-delimited JSON requests, each answered by a line with its `id`:
 *
 *   {"id":1,"op":"hello","name":"Claude"}             -> {"width","height","name"}
 *   {"id":2,"op":"screenshot"}                        -> {"width","height","png","region","windows"}
 *   {"id":2,"op":"screenshot","region":{"x","y","width","height"}}   only that part, sharper
 *   {"id":3,"op":"click","x":10,"y":20,"button":"left","count":1}
 *   {"op":"move" | "drag" | "scroll" | "type" | "key", ...}
 *   {"id":4,"op":"draw","points":[[x,y],...],"color":"#1e1e1e","width":2}
 *   {"id":5,"op":"talk","to":"Rex","about":"bug"}     hand something to another agent
 *
 * Coordinates are pixels of the surface. Each agent has a pointer of its own
 * there. A click, drag or scroll goes straight to the window under it through
 * the compositor's `injectPointer`, whether the view shows that window or not,
 * and neither the person's pointer nor the view moves; a screenshot shows any
 * part of the surface, from the windows' own pixels. Keys go to the window the
 * agent last clicked, given the keyboard quietly for them, through
 * proscenium-drive, the virtual keyboard beside the compositor's binary. A
 * stroke goes on the world's paper directly. scripts/computer-use-mcp.mjs
 * carries an MCP client's tool calls here.
 *
 * Several agents can work at once, their pointers each their own. There is
 * one keyboard, so what reaches windows takes turns, one whole action at a
 * time, each agent's in its own order.
 *
 * Worlds show what each agent does from `useComputerUse()`, a screenshot as an
 * action once it is taken; `stopComputerUse()` lets one go, or all.
 */

import { spawn } from "node:child_process";
import { readlinkSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { encodePng, focus, injectPointer, useFocusedWindow, useWindows, type InjectedPointer,
  type WindowInfo } from "proscenium";

export interface Point {
  x: number;
  y: number;
}

/** A part of the surface, in its pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One way an agent's pointer travels, numbered, in the surface's pixels. */
export interface Stroke {
  serial: number;
  from: Point;
  to: Point;
  /** With a button held, as in a drag: slower, and straight. */
  pressed: boolean;
  /** Seconds it waits at FROM first. */
  delay: number;
}

/** An agent at the computer, and what it is doing, as the world shows it. */
export interface AgentState {
  /** Numbered as it connects, never again. */
  id: number;
  /** Its place among the agents at work, from 0: the lowest free one as it came, for a world to give each its own look. */
  seat: number;
  name: string;
  /** Where its pointer is, or is headed, on the surface; null before it shows. */
  cursor: Point | null;
  /** How the pointer is getting there, for the world to draw it on that curve. */
  stroke: Stroke | null;
  /** Its latest action, numbered, for a click to ripple once; a screenshot's with the part it took. */
  action: { serial: number; kind: string; x?: number; y?: number; region?: Region } | null;
  /** It is drawing a stroke, the pointer moving with the pen. */
  drawing: boolean;
  /** It has the turn: one of its actions is reaching windows. */
  busy: boolean;
  /** Its keys may have just opened an application: the next window is its own, for a world to show it opening. */
  opening: boolean;
  /** It is telling another agent (by id) something, numbered, ABOUT one of `talkTopics`, for a world to show them meet. */
  talk: { serial: number; with: number; about: string } | null;
}

/** What one agent can tell another about; a world shows each its own way. */
export const talkTopics = ["bug", "doc", "code", "pr", "check", "chat"] as const;
/** How long a talk takes: the two meeting, and saying their piece. */
const talkSeconds = 4.6;

/** A window under a point of the surface, and that point in the window's own logical pixels. */
export interface WindowPoint {
  window: number;
  x: number;
  y: number;
}

/** A window on the surface, for an agent's bearings: where its box lies there. */
export interface SurfaceWindow {
  id: number;
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a world lays out for agents to work on, in pixels of its own. */
export interface AgentSurface {
  width: number;
  height: number;
  /** Where an agent's pointer first shows: where the person looks, say. */
  home(): Point;
  /** The topmost window at P, and where in it; null on bare surface. */
  windowAt(p: Point): WindowPoint | null;
  /** P in WINDOW's own pixels, inside it or not; null once it is gone. */
  pointIn(window: number, p: Point): WindowPoint | null;
  /** REGION's pixels, as straight RGBA, no wider or taller than MOST. */
  capture(region: Region, most: number): Promise<{ width: number; height: number; pixels: Uint8Array }>;
  windows(): SurfaceWindow[];
  /** A stroke through POINTS on the surface's paper, in COLOR (#rrggbb) and WIDTH (Excalidraw's, 1 to 16). */
  draw(points: Point[], color: string, width: number): Promise<void>;
}

/**
 * STROKE as a hand makes it: easing out and in along a minimum-jerk curve,
 * bowed a little to one side unless a button is held, and longer for longer
 * ways as Fitts's law has it. AT takes progress 0..1, delay included, to a point.
 */
export function strokeMotion(stroke: Stroke): { seconds: number; at: (progress: number) => Point } {
  const { from, to, delay } = stroke;
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  if (distance < 1) return { seconds: 0, at: () => to };
  const travel = (0.2 + 0.07 * Math.log2(1 + distance / 12)) * (stroke.pressed ? 1.5 : 1);
  const seconds = delay + travel;
  // Bowed upward whichever way it goes, as a wrist swings; LIFT is per pixel of the way.
  const bow = stroke.pressed ? 0 : (Math.min(40, distance * 0.1) * (dx >= 0 ? 1 : -1)) / distance;
  return {
    seconds,
    at(progress) {
      const t = Math.min(1, Math.max(0, (progress * seconds - delay) / travel));
      const s = t * t * t * (10 + t * (6 * t - 15));
      const lift = bow * Math.sin(Math.PI * s);
      return { x: from.x + dx * s + dy * lift, y: from.y + dy * s - dx * lift };
    },
  };
}

let agents: readonly AgentState[] = [];
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
function publish(id: number, next: Partial<AgentState>) {
  agents = agents.map((agent) => (agent.id === id ? { ...agent, ...next } : agent));
  notify();
}

/** The agents at work now, without following them: for a node just appearing to ask. */
export function agentsNow(): readonly AgentState[] {
  return agents;
}

/** The agents at work, in the order they came, for a world to show. */
export function useComputerUse(): readonly AgentState[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => agents);
}

const sessions = new Map<number, Socket>();
let agentIds = 0;

/** Let agent ID go, or every agent: its requests fail from now on, saying the person stopped it. */
export function stopComputerUse(id?: number): void {
  for (const [key, socket] of sessions) {
    if (id !== undefined && key !== id) continue;
    socket.end(JSON.stringify({ error: "The person stopped computer use." }) + "\n");
    socket.destroy();
  }
}

/** What reaches windows, from whichever agent, one whole action at a time. */
let turns: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turns.then(work);
  turns = run.catch(() => undefined);
  return run;
}

// The window an agent gave the keyboard last, and until when, for a world to leave its view be.
let quiet: { window: number; until: number } | null = null;

/** Whether WINDOW has the keyboard because an agent gave it, just now: a world need not bring it into view. */
export function focusedByAgent(window: number | null): boolean {
  return window !== null && quiet?.window === window && performance.now() < quiet.until;
}

/** Marks WINDOW as given the keyboard by an agent, and with FOCUS gives it. */
function quietly(window: number, give: boolean) {
  quiet = { window, until: performance.now() + 1000 };
  if (give) focus(window);
}

/** Widest or tallest the screenshots get, as computer-use models see them best. */
const widest = 1400;
/** A stroke's points, at most; how fast the pointer traces it, in surface pixels a second; and for how long at most. */
const strokeMost = 400;
const penSpeed = 1500;
const penLongest = 1.5;

/** The drive tool beside the running compositor's binary: on a real seat the only client
 * the compositor offers virtual input, so PROSCENIUM_DRIVE serves headless sessions alone. */
function driveBinary(): string {
  if (process.env.PROSCENIUM_DRIVE) return process.env.PROSCENIUM_DRIVE;
  const parent = process.env.PROSCENIUM_PARENT;
  return join(dirname(readlinkSync(`/proc/${parent}/exe`)), "proscenium-drive");
}

/** Play drive commands LINES, done once the drive is. */
function drive(lines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(driveBinary(), [], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `drive exited ${code}`))));
    child.stdin.end(lines.join("\n") + "\n");
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Evdev codes of the buttons an agent presses. */
const buttons: Record<string, number> = { left: 0x110, right: 0x111, middle: 0x112 };
const modifiers: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", shift: "shift", super: "super", meta: "super", cmd: "super",
};
/** Key names an agent tends to use, to the keysyms the drive taps. */
const keysyms: Record<string, string> = {
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space",
  backspace: "BackSpace", delete: "Delete", up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
};

/** "ctrl+shift+t" as the drive's chord, or a plain key. */
function chord(keys: string): string {
  const parts = keys.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const name = keysyms[key.toLowerCase()] ?? key;
  const held = parts.map((part) => modifiers[part.toLowerCase()]).filter(Boolean);
  return held.length ? `chord ${[...held, name].join("+")}` : `key ${name}`;
}

/** What the service asks of the world: its surface, and which windows there are and which has the keyboard. */
interface Desk {
  surface: () => AgentSurface | null;
  focused: () => number | null;
  exists: (window: number) => boolean;
  windowIds: () => number[];
  /** Agents at once, at most. */
  most: number;
}

/**
 * Serves agents on SURFACE while mounted, MOST of them at once; any world
 * showing them renders this.
 */
export function ComputerUseService({ surface, most = 4 }: { surface: AgentSurface | null; most?: number }) {
  const current = useRef(surface);
  current.current = surface;
  const focused = useRef<number | null>(null);
  focused.current = useFocusedWindow();
  const windows = useRef<readonly WindowInfo[]>([]);
  windows.current = useWindows();
  const desk = useRef<Desk>({
    surface: () => current.current,
    focused: () => focused.current,
    exists: (window) => windows.current.some((info) => info.id === window),
    windowIds: () => windows.current.map((info) => info.id),
    most,
  }).current;
  desk.most = most;
  useEffect(() => {
    const path = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "proscenium-computer-use.sock");
    rmSync(path, { force: true });
    const server: Server = createServer((socket) => serve(socket, desk));
    server.listen(path);
    return () => {
      stopComputerUse();
      server.close();
      rmSync(path, { force: true });
      sessions.clear();
      agents = [];
      notify();
    };
  }, []);
  return null;
}

function serve(socket: Socket, desk: Desk) {
  if (sessions.size >= desk.most) {
    socket.end(JSON.stringify({ error: `${desk.most} agents are using the computer already, as many as it takes.` }) + "\n");
    return;
  }
  const id = ++agentIds;
  const seats = new Set(agents.map((agent) => agent.seat));
  let seat = 0;
  while (seats.has(seat)) seat++;
  sessions.set(id, socket);
  agents = [...agents, {
    id, seat, name: "Agent", cursor: null, stroke: null, action: null, drawing: false, busy: false, opening: false,
    talk: null,
  }];
  notify();
  const me = () => agents.find((agent) => agent.id === id);
  const alive = () => sessions.get(id) === socket;
  // The window it works in: the one it last clicked, dragged or scrolled in, or opened with a key.
  let window: number | null = null;
  let serial = 0, strokes = 0, talks = 0;
  let queue = Promise.resolve();
  let buffered = "";

  function surface(): AgentSurface {
    const surface = desk.surface();
    if (!surface) throw new Error("The world has nothing laid out to work on yet.");
    return surface;
  }

  /** The agent's pointer travels to P, done once there. */
  async function travel(p: Point, pressed = false) {
    const stroke: Stroke = { serial: ++strokes, from: me()?.cursor ?? p, to: p, pressed, delay: 0 };
    publish(id, { cursor: p, stroke });
    await sleep(strokeMotion(stroke).seconds * 1000);
  }

  /** An action where the pointer is, or at WHERE, where it is put without a stroke. */
  function act(kind: string, where?: Point, region?: Region) {
    const cursor = where ?? me()?.cursor ?? null;
    publish(id, { cursor, ...(where ? { stroke: null } : {}), action: { serial: ++serial, kind, ...cursor, ...(region && { region }) } });
  }

  /** WORK once it is this agent's turn at the windows. */
  function turn<T>(work: () => Promise<T>): Promise<T> {
    return inTurn(async () => {
      if (!alive()) throw new Error("The person stopped computer use.");
      publish(id, { busy: true });
      try {
        return await work();
      } finally {
        if (alive()) publish(id, { busy: false });
      }
    });
  }

  /**
   * A window the agent's keys open, watched for a while after them: it comes out
   * of the agent's pointer as the world shows it, and the pointer goes along to
   * its middle, the window the agent works in from then on.
   */
  async function watchOpening(before: Set<number>) {
    publish(id, { opening: true });
    const until = performance.now() + 4000;
    while (alive() && performance.now() < until) {
      const fresh = desk.windowIds().find((each) => !before.has(each));
      const box = fresh === undefined ? undefined : desk.surface()?.windows().find((each) => each.id === fresh);
      if (box) {
        // Laid out, so the world has it coming out of the pointer already.
        publish(id, { opening: false });
        window = box.id;
        await travel({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        if (alive()) act("open");
        return;
      }
      await sleep(40);
    }
    if (alive()) publish(id, { opening: false });
  }

  /** EVENTS for the window under the press, which takes the keyboard without the view moving to it. */
  function press(target: number, events: InjectedPointer[]) {
    quietly(target, false);
    injectPointer(target, events);
    window = target;
  }

  /** What one says of where it acted. */
  function landed(hit: WindowPoint | null) {
    return { window: hit ? surface().windows().find((info) => info.id === hit.window)?.title ?? "" : null };
  }

  async function handle(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const number = (key: string) => Number(request[key] ?? 0);
    const at = (x = number("x"), y = number("y")): Point => ({ x, y });
    switch (request.op) {
      case "hello": {
        // Named as it asks, numbered past another of that name.
        const asked = String(request.name ?? "Agent").slice(0, 24) || "Agent";
        const others = new Set(agents.filter((agent) => agent.id !== id).map((agent) => agent.name));
        let name = asked;
        for (let n = 2; others.has(name); n++) name = `${asked} ${n}`;
        // Its pointer shows up where the person looks, each agent's a little apart.
        const home = surface().home();
        publish(id, { name, cursor: me()?.cursor ?? { x: home.x + seat * 56, y: home.y + seat * 40 } });
        return { width: surface().width, height: surface().height, name };
      }
      case "screenshot": {
        const { width, height } = surface();
        // The part the agent picked, or all of it.
        const asked = request.region as Record<string, number> | undefined;
        const left = asked ? Math.max(0, Math.min(width - 8, Number(asked.x) || 0)) : 0;
        const top = asked ? Math.max(0, Math.min(height - 8, Number(asked.y) || 0)) : 0;
        const region = {
          x: left,
          y: top,
          width: asked ? Math.max(8, Math.min(width - left, Number(asked.width) || width)) : width,
          height: asked ? Math.max(8, Math.min(height - top, Number(asked.height) || height)) : height,
        };
        const shot = await surface().capture(region, widest);
        const png = await encodePng(shot);
        act("screenshot", undefined, region);
        return {
          width: shot.width, height: shot.height, png: png.toString("base64"),
          region: [region.x, region.y, region.width, region.height], windows: surface().windows(),
        };
      }
      case "move":
        await travel(at());
        act("move");
        return {};
      case "click": {
        const p = at();
        await travel(p);
        const count = Math.max(1, Math.min(3, number("count") || 1));
        const button = buttons[String(request.button ?? "left")] ?? buttons.left!;
        act(count > 1 ? "double" : "click");
        return turn(async () => {
          const hit = surface().windowAt(p);
          if (hit) {
            const clicks = Array.from({ length: count }, () => [{ button, pressed: true }, { button, pressed: false }]).flat();
            press(hit.window, [{ motion: [hit.x, hit.y] }, ...clicks]);
          }
          return landed(hit);
        });
      }
      case "drag": {
        const from = at(number("fromX"), number("fromY")), to = at(number("toX"), number("toY"));
        await travel(from);
        act("drag");
        const stroke: Stroke = { serial: ++strokes, from, to, pressed: true, delay: 0.06 };
        publish(id, { cursor: to, stroke });
        const motion = strokeMotion(stroke);
        await sleep(motion.seconds * 1000);
        return turn(async () => {
          const hit = surface().windowAt(from);
          if (hit) {
            // The way the pointer went, a step every few pixels, in the window it pressed.
            const steps = Math.max(1, Math.min(120, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 6)));
            const way = Array.from({ length: steps }, (_, i) => surface().pointIn(hit.window, motion.at((i + 1) / steps)))
              .flatMap((q): InjectedPointer[] => (q ? [{ motion: [q.x, q.y] }] : []));
            press(hit.window, [{ motion: [hit.x, hit.y] }, { button: buttons.left!, pressed: true }, ...way,
                               { button: buttons.left!, pressed: false }]);
          }
          return landed(hit);
        });
      }
      case "scroll": {
        const p = at();
        await travel(p);
        act("scroll");
        return turn(async () => {
          const hit = surface().windowAt(p);
          if (hit) {
            injectPointer(hit.window, [{ motion: [hit.x, hit.y] }, { wheel: Math.round(number("dy")) || 3 }]);
          }
          return landed(hit);
        });
      }
      case "draw": {
        const raw = Array.isArray(request.points) ? (request.points as unknown[]).slice(0, strokeMost) : [];
        const points = raw
          .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && p.every((n) => Number.isFinite(Number(n))))
          .map(([x, y]) => at(Number(x), Number(y)));
        if (points.length < 2) throw new Error("A stroke needs two points or more.");
        const color = /^#[0-9a-f]{6}$/i.test(String(request.color)) ? String(request.color) : "#1e1e1e";
        const width = Math.max(1, Math.min(16, Number(request.width) || 2));
        // The pointer traces the stroke, quickly, and the stroke is on the paper as it lifts.
        await travel(points[0]!);
        let length = 0;
        const reached = [0];
        for (let i = 1; i < points.length; i++) {
          length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
          reached.push(length);
        }
        const seconds = Math.min(penLongest, length / penSpeed);
        act("draw", points[0]);
        publish(id, { drawing: true });
        const timers = points.slice(1).map((p, i) => setTimeout(() => act("draw", p), (reached[i + 1]! / (length || 1)) * seconds * 1000));
        try {
          await sleep(seconds * 1000 + 40);
          await surface().draw(points, color, width);
        } finally {
          timers.forEach(clearTimeout);
          if (alive()) {
            act("drawn", points[points.length - 1]);
            publish(id, { drawing: false });
          }
        }
        return {};
      }
      case "talk": {
        // Another agent at the computer, by its name, told something: the world shows them meet.
        const to = agents.find((agent) => agent.id !== id && agent.name === String(request.to ?? ""));
        if (!to) throw new Error(`No other agent named ${JSON.stringify(request.to)} is at the computer.`);
        const about = (talkTopics as readonly string[]).includes(String(request.about)) ? String(request.about) : "chat";
        publish(id, { talk: { serial: ++talks, with: to.id, about } });
        await sleep(talkSeconds * 1000);
        return {};
      }
      case "type":
      case "key": {
        act(String(request.op));
        return turn(async () => {
          // Its own window has the keyboard again if another agent, or the person, took it.
          if (window !== null && desk.exists(window) && desk.focused() !== window) {
            quietly(window, true);
            await sleep(60);
          }
          // Before the keys, as an application they start may show its window at once.
          const before = new Set(desk.windowIds());
          publish(id, { opening: true });
          if (request.op === "type") {
            // A line at a time, Return between: a newline would end the drive's command.
            const lines = String(request.text ?? "").split("\n");
            await drive(lines.flatMap((line, index) => [...(index ? ["key Return"] : []), ...(line ? [`type ${line}`] : [])]));
          } else {
            await drive([chord(String(request.keys ?? ""))]);
            // A key may open a window, which is the agent's to work in then.
            await sleep(150);
            window = desk.focused() ?? window;
          }
          // What it typed reaches the window's pixels, shown or not; an application it opened, its pointer.
          if (window !== null && desk.exists(window)) injectPointer(window, []);
          void watchOpening(before);
          return {};
        });
      }
      default:
        throw new Error(`Unknown op ${JSON.stringify(request.op)}.`);
    }
  }

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let line: number;
    while ((line = buffered.indexOf("\n")) >= 0) {
      const text = buffered.slice(0, line);
      buffered = buffered.slice(line + 1);
      if (!text.trim()) continue;
      // One request at a time, in order.
      queue = queue.then(async () => {
        let request: Record<string, unknown> = {};
        try {
          request = JSON.parse(text);
          const result = await handle(request);
          socket.write(JSON.stringify({ id: request.id, ok: true, ...result }) + "\n");
        } catch (error) {
          socket.write(JSON.stringify({ id: request.id, ok: false, error: String((error as Error).message ?? error) }) + "\n");
        }
      });
    }
  });
  const end = () => {
    if (!alive()) return;
    sessions.delete(id);
    agents = agents.filter((agent) => agent.id !== id);
    notify();
  };
  socket.on("close", end);
  socket.on("error", end);
}
