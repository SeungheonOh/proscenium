/**
 * Notifications: while anything shows them, the shell is the desktop's
 * notification server. The server itself is notification-service.py, which
 * owns org.freedesktop.Notifications on the session bus, keeps the
 * notifications and ends them when their time is up; this module runs it,
 * holds the picture it last gave, and sends it what the user chooses.
 *
 * Warlock shows no banners: a notification arriving changes the taskbar's
 * count and the Notifications panel, nothing else.
 */

import { post } from "./message-log.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { useSyncExternalStore } from "react";
import service from "./notification-service.py?url";

/** python3-gi belongs to the system's interpreter, whatever else PATH offers. */
const python = "/usr/bin/python3";

/** Where a notification is in its life; all but "live" are history. */
export type NotificationState =
  | "live"
  | "expired"
  | "invoked"
  | "dismissed"
  | "closed"
  | "disconnected"
  | "unknown"
  | "unavailable";

export interface NotificationAction {
  key: string;
  label: string;
}

export interface NotificationEntry {
  /** The id its producer knows it by; a replacement keeps it. */
  id: number;
  /** Unique to this notification: a replacement has another. */
  incarnation: number;
  app: string;
  summary: string;
  body: string;
  /** 0 low, 1 normal, 2 critical. */
  urgency: number;
  state: NotificationState;
  /** What its producer offers; empty once it is history. */
  actions: readonly NotificationAction[];
}

export interface Notifications {
  /** Live and past together, newest first. */
  entries: readonly NotificationEntry[];
  /** The panel's status line. */
  notice: string;
  /** Whether the service is being read again. */
  reading: boolean;
  /** Whether an action or a dismissal can be chosen: none is on its way, and nothing is being read. */
  ready: boolean;
  /** Session choices, off when the shell starts and never stored. */
  doNotDisturb: boolean;
  criticalInterruptions: boolean;
}

const loading = "Loading notifications…";
/** The service process could not be run, or went away. */
const failed =
  "Notifications unavailable. Refresh notifications to read current status. No action will be repeated.";

/** What the service says about itself in every message. */
interface Picture {
  available: boolean;
  reason: string;
  entries: NotificationEntry[];
}

interface Message extends Picture {
  event: "state" | "read" | "outcome";
  request?: number;
  status?: "Dispatched" | "Refused" | "Unknown";
}

let view: Notifications = {
  entries: [],
  notice: loading,
  reading: false,
  ready: false,
  doNotDisturb: false,
  criticalInterruptions: false,
};
let liveCount = 0;
let available = false;
/** The action or dismissal the service has not answered, by its request and the notification it is for. */
let pending: { request: number; incarnation: number } | null = null;
/** The read the service has not answered. */
let reading: number | null = null;
let requests = 0;
let child: ChildProcess | null = null;
const listeners = new Set<() => void>();

function isLive(entries: readonly NotificationEntry[], incarnation: number): boolean {
  return entries.some((entry) => entry.incarnation === incarnation && entry.state === "live");
}

/** Show ENTRIES and NOTICE (or what they were), with what is pending as it now is. */
function show(change: {
  entries?: readonly NotificationEntry[];
  notice?: string;
  doNotDisturb?: boolean;
  criticalInterruptions?: boolean;
}): void {
  view = {
    ...view,
    ...change,
    reading: reading !== null,
    ready: available && pending === null && reading === null,
  };
  liveCount = view.entries.filter((entry) => entry.state === "live").length;
  for (const listener of [...listeners]) listener();
}

/** The status line for a picture when nothing else is going on. */
function describe(picture: Picture): string {
  if (!picture.available) return picture.reason;
  const live = picture.entries.filter((entry) => entry.state === "live").length;
  return live === 0
    ? "No live notifications. Previous notifications remain in history."
    : `${live} live notifications. Actions apply only to the current notification.`;
}

function hear(line: string): void {
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    return;
  }
  available = message.available;
  // A request on its way keeps the status line until it is answered.
  let notice = pending ? view.notice : describe(message);
  if (message.event === "outcome" && pending && message.request === pending.request) {
    if (message.status === "Unknown") {
      notice = "Notification action not confirmed. It will not be repeated.";
    } else {
      pending = null;
      notice =
        message.status === "Dispatched"
          ? "Notification action sent."
          : "Notification action refused. The target expired or changed; choose a current notification.";
    }
  } else if (message.event === "read" && message.request === reading) {
    reading = null;
    if (pending && !isLive(message.entries, pending.incarnation)) {
      pending = null;
      notice = "Notification target is no longer live. Its action will not be repeated.";
    }
  }
  for (const entry of message.entries)
    if (entry.state === "live" && !heard.has(`${entry.id}.${entry.incarnation}`))
      post("sub", "Notification", `${entry.app} "${entry.summary}"`);
  heard = new Set(message.entries.map((entry) => `${entry.id}.${entry.incarnation}`));
  show({ entries: message.entries, notice });
}

/** Notifications already written down in the Messages panel's log. */
let heard = new Set<string>();

function send(command: Record<string, unknown>): void {
  child?.stdin?.write(`${JSON.stringify(command)}\n`);
}

function start(): void {
  let started: ChildProcess;
  try {
    started = spawn(python, [service], { stdio: ["pipe", "pipe", "inherit"] });
  } catch {
    gone(null);
    return;
  }
  child = started;
  started.on("error", () => gone(started));
  started.on("close", () => gone(started));
  // Writing to a service that has just gone is not an error to stop for.
  started.stdin!.on("error", () => undefined);
  createInterface({ input: started.stdout! }).on("line", (line) => {
    if (child === started) hear(line);
  });
}

/** The service ENDED, or could not run: what was live can no longer be acted on. */
function gone(ended: ChildProcess | null): void {
  if (child !== ended) return;
  child = null;
  available = false;
  pending = null;
  reading = null;
  show({
    entries: view.entries.map((entry) =>
      entry.state === "live" ? { ...entry, state: "unavailable", actions: [] } : entry,
    ),
    notice: failed,
  });
}

function stop(): void {
  const stopped = child;
  child = null;
  available = false;
  pending = null;
  reading = null;
  view = { ...view, entries: [], notice: loading, reading: false, ready: false };
  liveCount = 0;
  // The service ends when its input closes; the signal is for one that is stuck.
  stopped?.stdin?.end();
  stopped?.kill();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!child && listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    // Not at once: a reader that remounts lets go and takes hold again in one commit.
    if (listeners.size === 0) setTimeout(() => listeners.size === 0 && stop(), 0);
  };
}

/** How many notifications are live, for the taskbar's label. */
export function useLiveNotificationCount(): number {
  return useSyncExternalStore(subscribe, () => liveCount);
}

/** The notifications and what the panel says about them. */
export function useNotifications(): Notifications {
  return useSyncExternalStore(subscribe, () => view);
}

/** Read the service's notifications again; a service that could not run is tried again. */
export function refreshNotifications(): void {
  if (reading !== null) return;
  if (!child) start();
  if (!child) return;
  reading = ++requests;
  send({ command: "read", request: reading });
  show({});
}

/** Send the producer of ENTRY one of its actions (KEY), or dismiss ENTRY: one request at a time. */
function choose(command: "invoke" | "dismiss", entry: NotificationEntry, key?: string): void {
  if (!view.ready || !isLive(view.entries, entry.incarnation)) return;
  pending = { request: ++requests, incarnation: entry.incarnation };
  send({ command, request: pending.request, id: entry.id, incarnation: entry.incarnation, key });
  show({ notice: "Sending notification action…" });
}

export function invokeNotificationAction(entry: NotificationEntry, key: string): void {
  choose("invoke", entry, key);
}

export function dismissNotification(entry: NotificationEntry): void {
  choose("dismiss", entry);
}

/**
 * Do not disturb for this session. Warlock lets it silence only how arrivals
 * are announced to a screen reader, which a world has no way to do, so here it
 * is the choice alone: notifications still arrive, and the count and history
 * still follow.
 */
export function setDoNotDisturb(on: boolean): void {
  show({ doNotDisturb: on });
}

/** Whether critical notifications may interrupt this session, as far as Do not disturb lets them. */
export function setCriticalInterruptions(on: boolean): void {
  show({ criticalInterruptions: on });
}
