/**
 * The taskbar's application buttons: pinned applications in their saved order,
 * then every other application with windows, by its oldest window. A pin and
 * the windows of its application share one button.
 */

import { useMemo } from "react";
import {
  entryForApp,
  launchEntry,
  launchNotice,
  useCatalog,
  type CatalogEntry,
} from "./catalog.js";
import { pinsFile, useStored } from "./storage.js";
import { idleNotice, useWarlock, type WarlockContextValue } from "./WarlockProvider.js";

export interface TaskbarGroup {
  /** `pin:<desktop id>`, `application:<app id>`, or `window:<id>` for a window that names no application. */
  key: string;
  label: string;
  /** What Warlock's taskbar would say under the label: `Open`, `Active`, `2 windows`, `Pinned launcher`… */
  detail: string;
  /** The catalog entry it launches, when its application is installed. */
  entry: CatalogEntry | undefined;
  pinned: boolean;
  /** Its windows, oldest first. */
  windows: readonly number[];
  state: "none" | "open" | "minimized" | "active";
  /** A pin whose application is not installed: shown, but it does nothing. */
  unavailable: boolean;
}

/** The taskbar's application buttons, left to right. */
export function useTaskbarGroups(): TaskbarGroup[] {
  const { roots, windows, focusedRoot, state, label } = useWarlock();
  const { entries, loading } = useCatalog();
  const pins = useStored(pinsFile);

  return useMemo(() => {
    const byKey = new Map<string, number[]>();
    for (const id of roots) {
      const app = windows.get(id)?.appId ?? "";
      const key = app ? `application:${app}` : `window:${id}`;
      const group = byKey.get(key);
      if (group) group.push(id);
      else byKey.set(key, [id]);
    }

    const describe = (members: readonly number[]): Pick<TaskbarGroup, "state" | "detail"> => {
      const active =
        focusedRoot !== null &&
        members.includes(focusedRoot) &&
        !state.windows[focusedRoot]?.minimized;
      const minimized = members.every((id) => state.windows[id]?.minimized);
      const status = active ? "active" : minimized ? "minimized" : "open";
      const one = active ? "Active" : minimized ? "Minimized" : "Open";
      const detail =
        members.length > 1 ? `${active ? "Active; " : ""}${members.length} windows` : one;
      return { state: status, detail };
    };

    const groups: TaskbarGroup[] = [];
    const claimed = new Set<string>();
    for (const pin of pins) {
      const entry = entries.find((candidate) => candidate.id === pin);
      const match = [...byKey].find(([key]) => {
        if (claimed.has(key) || !key.startsWith("application:")) return false;
        return (
          entry !== undefined && entryForApp(entries, key.slice("application:".length)) === entry
        );
      });
      if (match) {
        claimed.add(match[0]);
        const described = describe(match[1]);
        groups.push({
          key: `pin:${pin}`,
          label: entry?.name ?? pin,
          detail: `Pinned; ${described.detail}`,
          entry,
          pinned: true,
          windows: match[1],
          state: described.state,
          unavailable: false,
        });
      } else {
        groups.push({
          key: `pin:${pin}`,
          label: entry?.name ?? pin,
          detail: entry ? "Pinned launcher" : "Unavailable application: ",
          entry,
          pinned: true,
          windows: [],
          state: "none",
          // Before the catalog is read, a pin is not yet known to be gone.
          unavailable: !entry && !loading,
        });
      }
    }
    for (const [key, members] of byKey) {
      if (claimed.has(key)) continue;
      const app = key.startsWith("application:") ? key.slice("application:".length) : "";
      groups.push({
        key,
        label: label(members[0]!) || "Windows",
        ...describe(members),
        entry: app ? entryForApp(entries, app) : undefined,
        pinned: false,
        windows: members,
        unavailable: false,
      });
    }
    return groups;
  }, [roots, windows, focusedRoot, state.windows, label, entries, loading, pins]);
}

/**
 * What a click on a taskbar button does: launch a pin without windows; with
 * one window, bring it back if minimized, put it away if it is the one in
 * use, else switch to it; with several, show them to choose from.
 */
export function groupPrimary(
  warlock: WarlockContextValue,
  group: TaskbarGroup,
  output?: string,
): void {
  const { state, focusedRoot, activate, minimize, openPopup, closePopup } = warlock;
  if (group.unavailable) return;
  if (group.windows.length === 0) {
    if (group.entry) {
      launchEntry(group.entry);
      warlock.notify(launchNotice("launch", "Launch submitted.", idleNotice));
    }
    closePopup();
    return;
  }
  if (group.windows.length > 1) {
    openPopup({ mode: "picker", group: group.key }, { output });
    return;
  }
  const window = group.windows[0]!;
  closePopup();
  if (state.windows[window]?.minimized) activate(window);
  else if (focusedRoot === window) minimize(window);
  else activate(window);
}

/** What a right click on a taskbar button does: the window's menu, the windows to choose from, or a pin's own actions. */
export function groupContext(
  warlock: WarlockContextValue,
  group: TaskbarGroup,
  options: { output?: string; anchor?: { x: number; y: number } | null } = {},
): void {
  if (group.unavailable) return;
  if (group.windows.length === 0) {
    if (group.entry) warlock.openPopup({ mode: "jump", entry: group.entry.id }, options);
  } else if (group.windows.length === 1)
    warlock.openPopup({ mode: "menu", window: group.windows[0]! }, options);
  else warlock.openPopup({ mode: "picker", group: group.key }, options);
}
