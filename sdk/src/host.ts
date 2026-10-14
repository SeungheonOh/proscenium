// React host configuration for Stage scene nodes.
//
// Instances exist locally from render time but reach the compositor, and
// layout, only when a commit attaches them, so work React abandons costs
// nothing. As a browser paints once per task, the commits of one task,
// including re-renders from layout effects and onLayout, become one `commit`
// message once <Box> layout has placed their nodes. After a reconnect the
// container replays its whole tree as one commit beginning with `reset`,
// letting the compositor hand on-screen motion from the old scene to the new
// one. Pointer events bubble through the tree here, as they do in the DOM.

import createReconciler from "react-reconciler";
import {
  ConcurrentRoot, ContinuousEventPriority, DefaultEventPriority, DiscreteEventPriority, NoEventPriority,
} from "react-reconciler/constants.js";
import { createContext, version } from "react";
import type { Node as YogaNode } from "yoga-layout";
import { toStageEvent, type StageElement } from "./events.js";
import {
  applyLayoutStyle, calculateLayout, createLayoutNode, textKeys, textMeasure, TextMetrics,
  type LayoutBox, type MeasureRequest,
} from "./layout.js";
import {
  type EventHandler, type HostType, type SpanFont, diffWire, escapeMarkup, isTextContent,
  normalizeProps, spanAttributes, textContent, wireType,
} from "./props.js";
import type { Op, WireEvent, WireProps } from "./protocol.js";
import { shaderOps } from "./shader.js";

export interface Instance extends StageElement {
  readonly id: number;
  readonly type: HostType;
  readonly container: Container;
  /** Wire props from the element's own props. */
  declared: WireProps;
  /** What the compositor is sent: the declared props, text content and layout. */
  wire: WireProps;
  handlers: Map<string, EventHandler>;
  /** Layout properties from the latest props. */
  style: Record<string, unknown>;
  onLayout: ((box: LayoutBox) => void) | null;
  parent: Instance | null;
  children: Instance[];
  /** Yoga node of an attached <Box>, and of each node a Box lays out. */
  yoga: YogaNode | null;
  layout: LayoutBox | null;
  /** Hidden by Suspense: shown as invisible without forgetting its props. */
  hidden: boolean;
  attached: boolean;
  /**
   * Inside a <Text>: a string (`text`) or a nested <Text> (`props`), which
   * become part of the outer Text's content instead of nodes of their own.
   */
  inline: { text: string | null; props: Record<string, unknown> } | null;
}

type Parent = Instance | Container;

/** Nodes a <Box> can lay out; the rest (bindings, cameras, ...) have no box. */
const flexItems = new Set<HostType>(["group", "rect", "box", "text", "image", "web", "window", "mirror"]);
const bubblingEvents = new Set(["pointerdown", "pointermove", "pointerup", "wheel"]);
/** Events that come in streams: as in the DOM, their updates batch instead of rendering at once. */
const continuousEvents = new Set(["pointermove", "wheel", "drag", "resize", "move", "update"]);
/** How long a commit waits for text measurements before using estimates. */
const measureTimeoutMs = 200;
const maxMeasureRounds = 3;
/** onLayout handlers re-rendering into new layouts settle within this many passes a frame. */
const maxLayoutPasses = 3;

export interface ContainerOptions {
  /** Receives each frame's ops. */
  send: (ops: Op[]) => void;
  /** Asks the compositor for text sizes, which arrive through receiveMeasurements. */
  measure?: (requests: MeasureRequest[]) => void;
  /** Reports what onLayout handlers throw. */
  onError?: (error: unknown) => void;
}

export class Container {
  readonly id = 0;
  readonly children: Instance[] = [];
  /** True once React has committed into this container. */
  committed = false;
  private readonly instances = new Map<number, Instance>();
  private readonly layoutRoots = new Set<Instance>();
  private readonly textMetrics = new TextMetrics();
  /** Props of create ops not yet sent, so layout places a node before it first appears. */
  private readonly unsent = new Map<Instance, WireProps>();
  private readonly laidOut = new Set<Instance>();
  /** Texts whose inline content changed in this commit. */
  private readonly texts = new Set<Instance>();
  private readonly awaiting = new Map<number, MeasureRequest>();
  private measureTimer: NodeJS.Timeout | null = null;
  private measureRounds = 0;
  private nextId = 1;
  private flushQueued = false;
  private ops: Op[] = [];
  /** This commit's `set` props by node, so a node changed twice sends one op. */
  private readonly sets = new Map<Instance, WireProps>();
  private resync = true;
  /** Shaders the compositor was sent since the last resync. */
  private readonly sentShaders = new Set<string>();

  private readonly send: (ops: Op[]) => void;
  private readonly measure?: (requests: MeasureRequest[]) => void;
  private readonly onError: (error: unknown) => void;

  constructor(options: ContainerOptions) {
    this.send = options.send;
    this.measure = options.measure;
    this.onError = options.onError ?? ((error) => { throw error; });
  }

  create(type: HostType, props: Record<string, unknown>, inText = false): Instance {
    if (inText) {
      if (type !== "text") throw new TypeError(`<Text> can hold text and <Text>, not ${type}`);
      return this.createInline(null, props);
    }
    const { wire, handlers, style, onLayout } = normalizeProps(type, props);
    return {
      id: this.nextId++, type, container: this, declared: wire, wire, handlers, style, onLayout,
      parent: null, children: [], yoga: null, layout: null, hidden: false, attached: false,
      inline: null,
    };
  }

  createText(text: string): Instance {
    return this.createInline(text, {});
  }

  private createInline(text: string | null, props: Record<string, unknown>): Instance {
    return {
      id: this.nextId++, type: "text", container: this, declared: {}, wire: {}, handlers: new Map(),
      style: {}, onLayout: null, parent: null, children: [], yoga: null, layout: null,
      hidden: false, attached: false, inline: { text, props },
    };
  }

  /** Gives a new Text the content of the strings and Texts inside it. */
  finishText(instance: Instance): void {
    if (instance.type === "text" && !instance.inline) instance.wire = this.compose(instance);
  }

  /** Notes that inline content changed, so its Text's content is composed again. */
  contentChanged(instance: Instance): void {
    let root = instance;
    while (root.inline && root.parent) root = root.parent;
    if (!root.inline) this.texts.add(root);
  }

  setText(instance: Instance, text: string): void {
    instance.inline!.text = text;
    this.contentChanged(instance);
  }

  /** Replace the next flush with a replay of the whole tree, e.g. after connecting. */
  requestResync(): void {
    this.resync = true;
  }

  commit(): void {
    this.committed = true;
    for (const text of this.texts) this.refresh(text);
    this.texts.clear();
    this.layout();
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Send what is committed, unless it waits for text to be measured. */
  flush(): void {
    if (this.measureTimer) return;
    this.notifyLayout();
    if (this.measureTimer) return;
    if (this.resync) {
      this.resync = false;
      // A compositor met anew knows no shaders; one that does takes them again unchanged.
      this.sentShaders.clear();
      this.ops = [{ op: "reset" }];
      this.sets.clear();
      for (const child of this.children) {
        this.emitCreate(child);
        this.ops.push({ op: "insert", parent: this.id, id: child.id, before: null });
      }
    }
    if (this.ops.length > 0) {
      const ops = this.ops;
      this.ops = [];
      this.unsent.clear();
      this.sets.clear();
      this.send([...shaderOps(ops, this.sentShaders), ...ops]);
    }
  }

  /** Call onLayout handlers; what they render joins this frame. */
  private notifyLayout(): void {
    for (let pass = 0; this.laidOut.size > 0 && pass < maxLayoutPasses; pass++) {
      const laidOut = [...this.laidOut];
      this.laidOut.clear();
      reconciler.flushSyncFromReconciler(() => {
        for (const instance of laidOut) {
          if (!instance.attached || !instance.layout) continue;
          try {
            instance.onLayout?.(instance.layout);
          } catch (error) {
            this.onError(error);
          }
        }
      });
    }
    this.laidOut.clear();
  }

  receiveMeasurements(results: readonly { key: number; width: number; height: number }[]): void {
    this.textMetrics.resolve(results);
    for (const { key } of results) this.awaiting.delete(key);
    if (this.awaiting.size === 0) this.measured();
  }

  dispatch(message: WireEvent): void {
    const target = this.instances.get(message.node);
    if (!target) return;
    const declared = isSettleEvent(message.name) ? placement(target) : null;
    // As in the DOM, a click's updates render before this task ends, while a
    // stream of moves batches into fewer renders.
    const previous = updatePriority;
    updatePriority = continuousEvents.has(message.name) ? ContinuousEventPriority : DiscreteEventPriority;
    try {
      this.deliver(target, message);
    } finally {
      updatePriority = previous;
    }
    // A native drag or resize leaves the node where the pointer did. Once the
    // handler's render has committed, any place it did not change is declared
    // again, so the node returns to it instead of staying stranded.
    if (declared) queueMicrotask(() => this.redeclare(target, declared));
  }

  private deliver(target: Instance, message: WireEvent): void {
    const name = message.name;
    const event = toStageEvent(message) as unknown as Record<string, unknown>;
    let stopped = false;
    // As on a DOM event, the nodes and stopPropagation are not enumerable: an event kept whole
    // or spread into state, which may be saved as JSON, holds only its own values.
    Object.defineProperties(event, {
      target: { value: target },
      currentTarget: { value: null, writable: true },
      stopPropagation: {
        value: () => {
          stopped = true;
        },
      },
    });
    const call = (node: Instance) => {
      const handler = node.handlers.get(name);
      if (!handler) return;
      event.currentTarget = node;
      handler(event as never);
    };

    if (name === "pointerenter" || name === "pointerleave") {
      // Like mouseenter and mouseleave: each ancestor the pointer entered or
      // left hears it, outermost first on entry and innermost first on exit.
      const other = this.instances.get(Number(event[name === "pointerenter" ? "from" : "to"]));
      delete event.from;
      delete event.to;
      Object.defineProperty(event, "relatedTarget", { value: other ?? null });
      const kept = new Set(ancestry(other));
      const changed = ancestry(target).filter((node) => !kept.has(node));
      for (const node of name === "pointerenter" ? changed.reverse() : changed) call(node);
    } else if (bubblingEvents.has(name)) {
      for (let node: Instance | null = target; node && !stopped; node = node.parent) call(node);
    } else {
      call(target);
    }
  }

  private redeclare(instance: Instance, declared: WireProps): void {
    if (!instance.attached) return;
    const current = placement(instance);
    const unchanged: WireProps = {};
    for (const [key, value] of Object.entries(declared)) {
      if (current[key] === value) unchanged[key] = value;
    }
    if (Object.keys(unchanged).length === 0) return;
    this.queueSet(instance, unchanged);
    this.flush();
  }

  appendInitial(parent: Instance, child: Instance): void {
    parent.children.push(child);
    child.parent = parent;
  }

  insert(parent: Parent, child: Instance, before: Instance | null): void {
    const siblings = parent.children;
    const existing = siblings.indexOf(child);
    if (existing >= 0) siblings.splice(existing, 1);
    if (before) siblings.splice(siblings.indexOf(before), 0, child);
    else siblings.push(child);
    child.parent = parent === this ? null : (parent as Instance);
    if (child.inline) {
      this.contentChanged(child);
      return;
    }
    if (parent === this || (parent as Instance).attached) {
      if (child.attached) this.placeInLayout(child);
      else this.emitCreate(child);
      this.ops.push({ op: "insert", parent: parent.id, id: child.id, before: before?.id ?? null });
    }
  }

  remove(parent: Parent, child: Instance): void {
    parent.children.splice(parent.children.indexOf(child), 1);
    if (child.inline) {
      this.contentChanged(parent as Instance);
      child.parent = null;
      return;
    }
    child.yoga?.getParent()?.removeChild(child.yoga);
    this.freeLayout(child);
    child.parent = null;
    if (child.attached) {
      this.ops.push({ op: "remove", parent: parent.id, id: child.id });
      this.detach(child);
    }
  }

  update(instance: Instance, props: Record<string, unknown>): void {
    if (instance.inline) {
      instance.inline.props = props;
      this.contentChanged(instance);
      return;
    }
    const previous = sent(instance);
    const { wire, handlers, style, onLayout } = normalizeProps(instance.type, props);
    instance.declared = wire;
    instance.wire = this.compose(instance);
    instance.handlers = handlers;
    instance.onLayout = onLayout;
    if (instance.yoga) {
      if (!sameStyle(instance.style, style)) {
        applyLayoutStyle(instance.yoga, style, instance.type === "box");
      }
      if (instance.type === "text" && textChanged(previous, instance.wire)) instance.yoga.markDirty();
    }
    instance.style = style;
    this.sendChanges(instance, previous);
  }

  setHidden(instance: Instance, hidden: boolean): void {
    const previous = sent(instance);
    instance.hidden = hidden;
    if (instance.inline) this.contentChanged(instance);
    else this.sendChanges(instance, previous);
  }

  private compose(instance: Instance): WireProps {
    const inline = instance.type === "text" && instance.children.length > 0
      ? composeText(instance)
      : null;
    const geometry = instance.layout ? this.geometry(instance, instance.layout) : null;
    return inline || geometry ? { ...instance.declared, ...inline, ...geometry } : instance.declared;
  }

  /** Sends a Text whose inline content changed. */
  private refresh(instance: Instance): void {
    const previous = sent(instance);
    instance.wire = this.compose(instance);
    if (instance.yoga && textChanged(previous, instance.wire)) instance.yoga.markDirty();
    this.sendChanges(instance, previous);
  }

  private sendChanges(instance: Instance, previous: WireProps): void {
    const changes = diffWire(previous, sent(instance));
    if (changes && instance.attached) this.queueSet(instance, changes);
  }

  private queueSet(instance: Instance, props: WireProps): void {
    const pending = this.sets.get(instance);
    if (pending) {
      Object.assign(pending, props);
    } else {
      this.sets.set(instance, props);
      this.ops.push({ op: "set", id: instance.id, props });
    }
  }

  private emitCreate(instance: Instance): void {
    instance.attached = true;
    this.instances.set(instance.id, instance);
    if (!instance.yoga) this.placeInLayout(instance);
    const props = sent(instance);
    this.unsent.set(instance, props);
    this.ops.push({ op: "create", id: instance.id, type: wireType(instance.type), props });
    for (const child of instance.children) {
      if (child.inline) continue;
      this.emitCreate(child);
      this.ops.push({ op: "insert", parent: instance.id, id: child.id, before: null });
    }
  }

  private detach(instance: Instance): void {
    instance.attached = false;
    this.instances.delete(instance.id);
    for (const child of instance.children) this.detach(child);
  }

  // Layout.

  private createLayoutNode(instance: Instance): YogaNode {
    const yoga = createLayoutNode();
    applyLayoutStyle(yoga, instance.style, instance.type === "box");
    if (instance.type === "text") {
      yoga.setMeasureFunc(textMeasure(this.textMetrics, () => instance.wire));
    }
    instance.yoga = yoga;
    return yoga;
  }


  /**
   * Gives an attached `child` its place in its parent Box's layout, after the
   * siblings before it; an outermost Box becomes a layout root.
   */
  private placeInLayout(child: Instance): void {
    const parent = child.parent;
    child.yoga?.getParent()?.removeChild(child.yoga);
    if (parent?.type === "box" && flexItems.has(child.type)) {
      const yoga = child.yoga ?? this.createLayoutNode(child);
      let index = 0;
      for (const sibling of parent.children) {
        if (sibling === child) break;
        if (sibling.yoga) index++;
      }
      parent.yoga!.insertChild(yoga, index);
    } else if (child.type === "box") {
      child.yoga ??= this.createLayoutNode(child);
      this.layoutRoots.add(child);
    }
  }

  /** Frees the Yoga nodes of `instance` and of every Box below it. */
  private freeLayout(instance: Instance): void {
    const visit = (node: Instance, top: boolean) => {
      if (node.yoga && (top || this.layoutRoots.has(node))) node.yoga.freeRecursive();
      this.layoutRoots.delete(node);
      this.laidOut.delete(node);
      for (const child of node.children) visit(child, false);
      node.yoga = null;
      node.layout = null;
    };
    visit(instance, true);
  }

  private layout(): void {
    for (const root of this.layoutRoots) {
      if (!root.yoga!.isDirty()) continue;
      calculateLayout(root.yoga!);
      this.applyLayout(root);
    }
    this.requestMeasurements();
  }

  private applyLayout(instance: Instance): void {
    // A hidden node keeps its last box, to reappear from where it was.
    if (instance.style.display === "none") return;
    const computed = instance.yoga!.getComputedLayout();
    const box = this.isLayoutRoot(instance)
      ? { x: num(instance.style.x), y: num(instance.style.y), width: computed.width, height: computed.height }
      : { x: computed.left, y: computed.top, width: computed.width, height: computed.height };
    if (!sameBox(instance.layout, box)) {
      instance.layout = box;
      this.place(instance, this.geometry(instance, box));
      if (instance.onLayout) this.laidOut.add(instance);
    }
    if (instance.type !== "box") return;
    for (const child of instance.children) if (child.yoga) this.applyLayout(child);
  }

  private isLayoutRoot(instance: Instance): boolean {
    return this.layoutRoots.has(instance);
  }

  /** Wire props placing `instance` in `box`; a layout root keeps its own position. */
  private geometry(instance: Instance, box: LayoutBox): WireProps {
    const values: WireProps = this.isLayoutRoot(instance) ? {} : { x: box.x, y: box.y };
    values.width = box.width;
    // Text takes its height from its lines.
    if (instance.type !== "text") values.height = box.height;
    return values;
  }

  private place(instance: Instance, values: WireProps): void {
    const previous = sent(instance);
    instance.wire = { ...instance.wire, ...values };
    const pending = this.unsent.get(instance);
    if (pending) Object.assign(pending, values);
    else this.sendChanges(instance, previous);
  }

  private requestMeasurements(): void {
    if (!this.textMetrics.hasPending()) return;
    const requests = this.textMetrics.takePending();
    if (!this.measure || this.measureRounds >= maxMeasureRounds) {
      // Without a compositor to ask, or after enough rounds, estimates stand.
      this.textMetrics.settle(requests);
      this.relayoutText();
      return;
    }
    this.measureRounds++;
    for (const request of requests) this.awaiting.set(request.key, request);
    this.measureTimer ??= setTimeout(() => {
      this.textMetrics.settle([...this.awaiting.values()]);
      this.awaiting.clear();
      this.measured();
    }, measureTimeoutMs);
    this.measure(requests);
  }

  private measured(): void {
    if (this.measureTimer) clearTimeout(this.measureTimer);
    this.measureTimer = null;
    this.relayoutText();
    if (!this.measureTimer) {
      this.measureRounds = 0;
      this.flush();
    }
  }

  /** Lays out again with the sizes the measurements brought. */
  private relayoutText(): void {
    const markText = (node: Instance) => {
      if (node.type === "text" && node.yoga) node.yoga.markDirty();
      for (const child of node.children) markText(child);
    };
    for (const root of this.layoutRoots) markText(root);
    this.layout();
  }
}

/** A Text's content from the strings and Texts inside it: Pango markup once any is styled. */
function composeText(root: Instance): WireProps {
  const raw = root.declared.markup === true;
  const styled = raw || root.children.some((child) => child.inline?.text === null);
  const write = (node: Instance, font: SpanFont): string => {
    if (node !== root && node.children.length === 0) {
      const { text, children } = node.inline!.props;
      const content = typeof text === "string" ? text : isTextContent(children) ? textContent(children) : "";
      return styled && !raw ? escapeMarkup(content) : content;
    }
    let out = "";
    for (const child of node.children) {
      const inline = child.inline;
      if (!inline || child.hidden) continue;
      if (inline.text !== null) {
        out += styled && !raw ? escapeMarkup(inline.text) : inline.text;
      } else {
        const [attributes, inner] = spanAttributes(inline.props, font);
        out += `<span${attributes}>${write(child, inner)}</span>`;
      }
    }
    return out;
  };
  const text = write(root, { weight: num(root.declared.fontWeight) || 400, italic: root.declared.italic === true });
  return styled ? { text, markup: true } : { text };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function sameBox(left: LayoutBox | null, right: LayoutBox): boolean {
  return left !== null && left.x === right.x && left.y === right.y && left.width === right.width
    && left.height === right.height;
}

function sameStyle(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function textChanged(previous: WireProps, next: WireProps): boolean {
  return textKeys.some((key) => previous[key] !== next[key]);
}

/** `node` and its ancestors, innermost first. */
function ancestry(node: Instance | undefined): Instance[] {
  const chain: Instance[] = [];
  for (let current = node ?? null; current; current = current.parent) chain.push(current);
  return chain;
}

const placementKeys = ["x", "y", "width", "height"] as const;

function isSettleEvent(event: string): boolean {
  return event === "dragend" || event === "resizeend";
}

/** The declared x, y, width and height of `instance`. */
function placement(instance: Instance): WireProps {
  const wire = sent(instance);
  const out: WireProps = {};
  for (const key of placementKeys) if (wire[key] !== undefined) out[key] = wire[key];
  return out;
}

function sent(instance: Instance): WireProps {
  return instance.hidden ? { ...instance.wire, visible: false } : instance.wire;
}

let updatePriority: number = NoEventPriority;
const hostContext = {};
/** The context below a <Text>, where strings and Texts are inline content. */
const textContext = {};

// The published typings trail react-reconciler 0.34, so the configuration is
// checked against the methods React actually calls rather than those types.
const hostConfig = {
  rendererPackageName: "proscenium",
  rendererVersion: version,
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),

  // React treats a null host context as missing.
  getRootHostContext: () => hostContext,
  getChildHostContext: (parent: object, type: HostType) => (type === "text" ? textContext : parent),
  getPublicInstance: (instance: Instance): StageElement => instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container: Container) => container.commit(),
  preparePortalMount: () => undefined,
  // A Text node's string children are its content, not child nodes.
  shouldSetTextContent: (type: HostType, props: Record<string, unknown>) =>
    type === "text" && isTextContent(props.children),
  createTextInstance(text: string, container: Container, context: object) {
    if (context !== textContext) {
      throw new TypeError(`Stage has no text nodes; wrap ${JSON.stringify(text)} in <Text>`);
    }
    return container.createText(text);
  },
  commitTextUpdate(instance: Instance, _previous: string, text: string) {
    instance.container.setText(instance, text);
  },
  resetTextContent(instance: Instance) {
    instance.container.contentChanged(instance);
  },

  createInstance(type: HostType, props: Record<string, unknown>, container: Container, context: object) {
    return container.create(type, props, context === textContext);
  },
  appendInitialChild(parent: Instance, child: Instance) {
    parent.container.appendInitial(parent, child);
  },
  finalizeInitialChildren(instance: Instance) {
    instance.container.finishText(instance);
    return false;
  },

  appendChild(parent: Instance, child: Instance) {
    parent.container.insert(parent, child, null);
  },
  appendChildToContainer(container: Container, child: Instance) {
    container.insert(container, child, null);
  },
  insertBefore(parent: Instance, child: Instance, before: Instance) {
    parent.container.insert(parent, child, before);
  },
  insertInContainerBefore(container: Container, child: Instance, before: Instance) {
    container.insert(container, child, before);
  },
  removeChild(parent: Instance, child: Instance) {
    parent.container.remove(parent, child);
  },
  removeChildFromContainer(container: Container, child: Instance) {
    container.remove(container, child);
  },
  clearContainer(container: Container) {
    for (const child of [...container.children]) container.remove(container, child);
  },
  commitUpdate(instance: Instance, _type: HostType, _previous: unknown, next: Record<string, unknown>) {
    instance.container.update(instance, next);
  },
  hideInstance(instance: Instance) {
    instance.container.setHidden(instance, true);
  },
  unhideInstance(instance: Instance) {
    instance.container.setHidden(instance, false);
  },
  hideTextInstance(instance: Instance) {
    instance.container.setHidden(instance, true);
  },
  unhideTextInstance(instance: Instance) {
    instance.container.setHidden(instance, false);
  },
  detachDeletedInstance: () => undefined,

  setCurrentUpdatePriority(priority: number) {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () => (updatePriority === NoEventPriority ? DefaultEventPriority : updatePriority),
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  trackSchedulerEvent: () => undefined,
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: () => undefined,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  suspendOnActiveViewTransition: () => undefined,
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  resetFormInstance: () => undefined,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  getInstanceFromNode: () => null,
  getInstanceFromScope: () => null,
  prepareScopeUpdate: () => undefined,
  createFragmentInstance: () => null,
};

type Reconciler = ReturnType<typeof createReconciler>;
export const reconciler: Reconciler = createReconciler(hostConfig as never);
// Registers with React DevTools when its backend is loaded (--dev); a no-op otherwise.
reconciler.injectIntoDevTools();

export function createRoot(container: Container, onError: (error: unknown) => void) {
  return reconciler.createContainer(container, ConcurrentRoot, null, false, null, "stage",
    onError, onError, onError, () => undefined, null);
}
