/**
 * What Warlock keeps on disk, where Warlock keeps it: small JSON files in
 * `$XDG_STATE_HOME/warlock`, each `{ schema, revision, <payload> }` with the
 * revision counting saves. A file is written whole to a temporary file and
 * renamed over the old one; one this code does not understand is left alone
 * and read as the defaults.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { defaultAppearance, type Appearance } from "./theme.js";

const directory = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "warlock");

interface Read<V> {
  revision: bigint;
  value: V;
}

/** One stored file, read once and again on `refresh`, shared by everything that reads it. */
export class StoredFile<V> {
  private current: Read<V>;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly name: string,
    private readonly schema: number,
    /** The payload's key in the file. */
    private readonly field: string,
    private readonly initial: V,
    /** The value RAW holds, or null if it is not one. */
    private readonly parse: (raw: unknown) => V | null,
  ) {
    this.current = this.load();
  }

  private load(): Read<V> {
    try {
      const file = JSON.parse(readFileSync(join(directory, this.name), "utf8")) as Record<
        string,
        unknown
      >;
      const value = file.schema === this.schema ? this.parse(file[this.field]) : null;
      if (value !== null && typeof file.revision === "string" && /^[1-9]\d*$/.test(file.revision))
        return { revision: BigInt(file.revision), value };
    } catch {
      // No file yet, or one that does not parse: the defaults.
    }
    return { revision: 1n, value: this.initial };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read = (): V => this.current.value;

  private publish(next: Read<V>): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Read the file again, as a panel's Refresh does. */
  refresh(): V {
    const next = this.load();
    if (JSON.stringify(next.value) !== JSON.stringify(this.current.value)) this.publish(next);
    else this.current = next;
    return this.current.value;
  }

  /** Store VALUE; false if the file could not be written, which leaves everything as it was. */
  save(value: V): boolean {
    const revision = this.load().revision + 1n;
    const path = join(directory, this.name);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({
        schema: this.schema,
        revision: String(revision),
        [this.field]: value,
      });
      writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {
      return false;
    }
    this.publish({ revision, value });
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Appearance: theme, text size, soft effects and transparency. */
export const appearanceFile = new StoredFile<Appearance>(
  "settings.json",
  2,
  "values",
  defaultAppearance,
  (raw) => {
    if (!isRecord(raw)) return null;
    const { theme, textScale, effectsOff, reducedTransparency } = raw;
    if (theme !== "night" && theme !== "dawn" && theme !== "high-contrast") return null;
    if (textScale !== 100 && textScale !== 125 && textScale !== 150 && textScale !== 200)
      return null;
    if (typeof effectsOff !== "boolean" || typeof reducedTransparency !== "boolean") return null;
    return { theme, textScale, effectsOff, reducedTransparency };
  },
);

/** The motion override: null follows the system, which here means full motion. */
export type MotionOverride = null | "reduced" | "full";

export const motionFile = new StoredFile<MotionOverride>(
  "motion.json",
  1,
  "override",
  null,
  (raw) => (raw === "reduced" || raw === "full" ? raw : null),
);

/** Pinned applications, by desktop-entry id, in taskbar order. */
export const pinLimit = 32;

export const pinsFile = new StoredFile<readonly string[]>(
  "taskbar.json",
  1,
  "identities",
  [],
  (raw) => {
    if (!Array.isArray(raw) || raw.length > pinLimit) return null;
    const valid = raw.every((id) => typeof id === "string" && id.length >= 1 && id.length <= 256);
    return valid && new Set(raw).size === raw.length ? (raw as string[]) : null;
  },
);

/** Which chord opens each of the three shortcuts that have a choice. */
export type ShortcutRoute = "applications" | "system" | "notifications";
export type ShortcutChoice = "undecided" | "keep" | "default" | "alternate";
export type ShortcutChoices = Record<ShortcutRoute, ShortcutChoice>;

export const shortcutRoutes: readonly {
  route: ShortcutRoute;
  label: string;
  chord: string;
  alternate: string;
}[] = [
  {
    route: "applications",
    label: "Apps menu",
    chord: "SUPER + ALT + SPACE",
    alternate: "SUPER + CTRL + ALT + SPACE",
  },
  {
    route: "system",
    label: "System menu",
    chord: "SUPER + ESCAPE",
    alternate: "SUPER + CTRL + ESCAPE",
  },
  {
    route: "notifications",
    label: "Notification history",
    chord: "SUPER + SHIFT + ALT + comma",
    alternate: "SUPER + CTRL + ALT + comma",
  },
];

const undecided: ShortcutChoices = {
  applications: "undecided",
  system: "undecided",
  notifications: "undecided",
};

export const shortcutsFile = new StoredFile<ShortcutChoices>(
  "shortcuts.json",
  1,
  "choices",
  undecided,
  (raw) => {
    if (!isRecord(raw)) return null;
    const choices = { ...undecided };
    for (const { route } of shortcutRoutes) {
      const choice = raw[route];
      if (
        choice !== "keep" &&
        choice !== "default" &&
        choice !== "alternate" &&
        choice !== "undecided"
      )
        return null;
      choices[route] = choice;
    }
    return choices;
  },
);

/** A stored file's value, current as it is saved or refreshed. */
export function useStored<V>(file: StoredFile<V>): V {
  return useSyncExternalStore(file.subscribe, file.read);
}
