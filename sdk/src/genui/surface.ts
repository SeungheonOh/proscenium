// A generated interface as data: its json-render spec and its state, changed by
// JSON patches as a model or a program streams them, and told to whoever draws
// it. The spec and state stay separate so a state change re-renders without
// touching the elements, and each element changed by a patch is a new object
// while the others keep theirs.

import { applySpecStreamPatch, getByPath, type JsonPatch, type Spec, type StateModel, type StateStore,
  type UIElement } from "@json-render/core";
import { immutableSetByPath } from "@json-render/core/store-utils";

export type { JsonPatch, Spec, StateModel, UIElement };

/** RFC 6901: "/a/b~1c" -> ["a", "b/c"]. */
export function parsePointer(path: string): string[] {
  if (path === "") return [];
  return path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointer(parts: readonly string[]): string {
  return parts.length ? "/" + parts.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "";
}

/** A state store as json-render's renderers expect one, notifying once per change. */
export class SurfaceState implements StateStore {
  private snapshot: StateModel;
  private readonly listeners = new Set<() => void>();

  constructor(initial: StateModel = {}) {
    this.snapshot = initial;
  }

  get = (path: string): unknown => getByPath(this.snapshot, path);

  set = (path: string, value: unknown): void => {
    if (this.get(path) === value) return;
    this.replace(path === "" || path === "/" ? (value as StateModel) ?? {} : immutableSetByPath(this.snapshot, path, value));
  };

  update = (updates: Record<string, unknown>): void => {
    let next = this.snapshot;
    for (const [path, value] of Object.entries(updates)) {
      if (path === "" || path === "/") next = (value ?? {}) as StateModel;
      else if (getByPath(next, path) !== value) next = immutableSetByPath(next, path, value);
    }
    if (next !== this.snapshot) this.replace(next);
  };

  getSnapshot = (): StateModel => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The whole state, replaced. */
  replace(next: StateModel): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** A JSON patch whose path is within the state ("" is the whole of it). */
  patch(operation: JsonPatch): void {
    const next = structuredClone(this.snapshot) as Record<string, unknown>;
    if (operation.path === "" && (operation.op === "add" || operation.op === "replace")) {
      this.replace((operation.value ?? {}) as StateModel);
      return;
    }
    applySpecStreamPatch(next, operation);
    this.replace(next);
  }
}

/** One generated interface: its spec, its state, and its listeners. */
export class Surface {
  /** The spec without its state, which lives in `state`. A new object whenever it changes. */
  spec: Spec = { root: "", elements: {} };
  readonly state: SurfaceState;
  private readonly listeners = new Set<() => void>();

  constructor(spec?: Partial<Spec>) {
    this.state = new SurfaceState();
    if (spec) this.reset(spec);
  }

  /** Replace the spec, and the state if SPEC has one. */
  reset(spec: Partial<Spec>): void {
    this.spec = { root: spec.root ?? "", elements: { ...(spec.elements ?? {}) } };
    if (spec.state) this.state.replace(spec.state);
    this.changed();
  }

  /**
   * Apply json-render patches (paths under /root, /elements and /state, or ""
   * for the whole spec), in order, as one change. Returns what could not be
   * applied, in words; the rest still is.
   */
  apply(patches: readonly JsonPatch[]): string[] {
    const problems: string[] = [];
    let { root, elements } = this.spec;
    let copied = false;
    for (const patch of patches) {
      try {
        if (!patch || typeof patch.path !== "string" || typeof patch.op !== "string") throw new Error("not a patch");
        const parts = parsePointer(patch.path);
        const head = parts[0];
        if (parts.length === 0) {
          if (patch.op !== "add" && patch.op !== "replace") throw new Error("only add or replace the whole spec");
          const whole = (patch.value ?? {}) as Partial<Spec>;
          root = whole.root ?? "";
          elements = { ...(whole.elements ?? {}) };
          copied = true;
          if (whole.state) this.state.replace(whole.state);
        } else if (head === "root") {
          if (patch.op === "remove") root = "";
          else root = String(patch.value ?? "");
        } else if (head === "elements") {
          if (!copied) {
            elements = { ...elements };
            copied = true;
          }
          if (parts.length === 1) {
            if (patch.op === "remove") elements = {};
            else elements = { ...((patch.value ?? {}) as Record<string, UIElement>) };
          } else if (parts.length === 2) {
            const key = parts[1]!;
            if (patch.op === "remove") delete elements[key];
            else if (patch.op === "add" || patch.op === "replace") elements[key] = normalize(patch.value);
            else throw new Error(`${patch.op} of a whole element`);
          } else {
            const key = parts[1]!;
            const element = elements[key];
            if (!element) throw new Error(`no element "${key}"`);
            const changed = structuredClone(element) as unknown as Record<string, unknown>;
            applySpecStreamPatch(changed, { ...patch, path: pointer(parts.slice(2)),
              from: patch.from === undefined ? undefined : pointer(parsePointer(patch.from).slice(2)) });
            elements[key] = normalize(changed);
          }
        } else if (head === "state") {
          this.state.patch({ ...patch, path: pointer(parts.slice(1)),
            from: patch.from === undefined ? undefined : pointer(parsePointer(patch.from).slice(1)) });
        } else {
          throw new Error("paths start with /root, /elements or /state");
        }
      } catch (error) {
        problems.push(`${JSON.stringify(patch)?.slice(0, 160)}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (root !== this.spec.root || elements !== this.spec.elements) {
      this.spec = { root, elements };
      this.changed();
    }
    return problems;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSpec = (): Spec => this.spec;

  /** The spec with its state, as a model or a program would send it. */
  toJSON(): Spec {
    return { ...this.spec, state: this.state.getSnapshot() };
  }

  /** Words a model can check its work by: missing children, unknown types, an absent root, state it reads but lacks. */
  problems(known: readonly string[]): string[] {
    const found: string[] = [];
    const { root, elements } = this.spec;
    const state = this.state.getSnapshot();
    if (!root) found.push("no /root yet");
    else if (!elements[root]) found.push(`root "${root}" has no element`);
    for (const [key, element] of Object.entries(elements)) {
      if (!known.includes(element.type)) found.push(`element "${key}" has unknown type "${element.type}"`);
      for (const child of element.children ?? []) {
        if (!elements[child]) found.push(`element "${key}" lists child "${child}", which does not exist`);
      }
      const props = element.props as Record<string, unknown> | undefined;
      for (const misplaced of ["visible", "on", "repeat", "watch"]) {
        if (props && misplaced in props) found.push(`element "${key}" has "${misplaced}" inside props; it goes on the element`);
      }
      // A value read from state that is not there shows as nothing until something sets it.
      const reads = new Set<string>();
      stateReads(props, reads);
      for (const path of reads) {
        if (path.startsWith("/_ui") || getByPath(state, path) !== undefined) continue;
        found.push(`element "${key}" shows ${path}, which its state does not have: it stays empty until something sets it`);
      }
    }
    return found;
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The paths VALUE reads from state as values, { "$state": path } alone; a $cond's condition may be unset (false). */
function stateReads(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const each of value) stateReads(each, found);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (typeof record.$state === "string" && keys.length === 1) {
    found.add(record.$state);
    return;
  }
  for (const key of keys) if (key !== "$cond") stateReads(record[key], found);
}

/** An element as the renderer needs it: props an object and children a list, whatever arrived. */
function normalize(value: unknown): UIElement {
  const element = (value ?? {}) as Partial<UIElement>;
  return {
    ...element,
    type: String(element.type ?? ""),
    props: element.props && typeof element.props === "object" ? element.props : {},
    children: Array.isArray(element.children) ? element.children.map(String) : [],
  } as UIElement;
}
