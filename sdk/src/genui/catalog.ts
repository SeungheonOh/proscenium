// The components and actions generated interfaces may use, as a json-render
// catalog: each component's props as a zod schema, the slots it takes and what
// it is for. The renderer (render.tsx) draws each with proscenium/ui, and
// catalogPrompt() tells a model how to write specs for them.

import { defineCatalog, defineSchema } from "@json-render/core";
import { z } from "zod";

const gap = z.enum(["none", "xs", "sm", "md", "lg", "xl"]);
const tone = z.enum(["default", "muted", "accent", "success", "warning", "danger"]);

/** The spec and catalog shapes: json-render's flat element tree, with `on` and `watch` on elements. */
export const schema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(s.object({
      type: s.ref("catalog.components"),
      props: s.propsOf("catalog.components"),
      children: s.array(s.string()),
      visible: { ...s.any(), ...s.optional() },
      repeat: { ...s.any(), ...s.optional() },
      on: { ...s.any(), ...s.optional() },
      watch: { ...s.any(), ...s.optional() },
    })),
  }),
  catalog: s.object({
    components: s.map({ props: s.zod(), slots: s.array(s.string()), description: s.string(), example: s.any() }),
    actions: s.map({ params: s.zod(), description: s.string() }),
  }),
}), {
  builtInActions: [
    { name: "setState", description: "Update a value in the state model at the given statePath. Params: { statePath: string, value: any }" },
    { name: "pushState", description: 'Append an item to an array in state. Params: { statePath: string, value: any, clearStatePath?: string }. Value can contain {"$state":"/path"} refs and "$id" for auto IDs.' },
    { name: "removeState", description: "Remove an item from an array in state by index. Params: { statePath: string, index: number }" },
  ],
  defaultRules: [
    "CRITICAL INTEGRITY CHECK: Before outputting ANY element that references children, you MUST have already output (or will output) each child as its own element. A missing child element makes that whole branch invisible.",
    'REQUIRED FIELDS: Every element MUST include a "children" array. Leaf elements use an empty array: "children": [].',
    'CRITICAL: "visible", "repeat", "on" and "watch" go on the ELEMENT object, NOT inside "props".',
    "When the UI displays data, include a state field with the real data you have (or realistic sample data when asked for a mock-up), and read it with $state / $item rather than repeating it in props.",
    "Use repeat on a container for lists backed by a state array; never hand-write one element per item.",
    "Bind every input you need to read with $bindState to a path you name. The interface keeps its own state under /_ui (inputs bound to nothing, countdown clocks): read it if you must, never write it.",
    "Interfaces are small panels on a desktop, about 360 px wide unless told otherwise: keep them compact and focused, a clear title, few words, no filler.",
  ],
});

export const catalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]).nullable(),
        gap: gap.nullable(),
        align: z.enum(["start", "center", "end", "stretch"]).nullable(),
        justify: z.enum(["start", "center", "end", "between"]).nullable(),
        wrap: z.boolean().nullable(),
        padding: gap.nullable(),
      }),
      slots: ["default"],
      description: "Lays children out in a column (default) or a row. The basic layout container.",
    },
    Card: {
      props: z.object({
        title: z.string().nullable(),
        subtitle: z.string().nullable(),
        variant: z.enum(["card", "plain", "tinted", "ink"]).nullable(),
        padding: gap.nullable(),
      }),
      slots: ["default"],
      description: "A rounded section with an optional title and subtitle; children in a column. Use to group content.",
    },
    Grid: {
      props: z.object({ columns: z.number(), gap: gap.nullable() }),
      slots: ["default"],
      description: "Children in rows of `columns` equal cells, e.g. 2 or 3 Metrics side by side.",
    },
    Heading: {
      props: z.object({ text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable() }),
      slots: [],
      description: "A title; level 1 is largest.",
    },
    Text: {
      props: z.object({
        text: z.union([z.string(), z.number()]),
        tone: tone.nullable(),
        size: z.enum(["sm", "md", "lg", "xl"]).nullable(),
        weight: z.enum(["regular", "medium", "bold"]).nullable(),
        align: z.enum(["start", "center", "end"]).nullable(),
        maxLines: z.number().nullable(),
        mono: z.boolean().nullable(),
      }),
      slots: [],
      description: "Plain text that wraps. Emoji are fine.",
    },
    Markdown: {
      props: z.object({ text: z.string() }),
      slots: [],
      description: "Rich text from Markdown: paragraphs, **bold**, *italic*, `code`, lists, links, headings, code blocks.",
    },
    Badge: {
      props: z.object({ text: z.union([z.string(), z.number()]), tone: tone.nullable() }),
      slots: [],
      description: "A small pill label: a status, a tag, a count.",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        unit: z.string().nullable(),
        delta: z.string().nullable(),
        trend: z.enum(["up", "down", "flat"]).nullable(),
        caption: z.string().nullable(),
      }),
      slots: [],
      description: "One number shown large with its label, and optionally a change (delta) and trend.",
    },
    KeyValue: {
      props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), tone: tone.nullable() }),
      slots: [],
      description: "A label on the left and its value on the right, one line: details, specs, totals.",
    },
    ProgressBar: {
      props: z.object({
        value: z.number().nullable(),
        label: z.string().nullable(),
        showValue: z.boolean().nullable(),
        tone: tone.nullable(),
      }),
      slots: [],
      description: "How far along something is: value from 0 to 1 (or 0 to 100). null value = busy, unknown length.",
    },
    List: {
      props: z.object({ dividers: z.boolean().nullable() }),
      slots: ["default"],
      description: "A column of ListItems, with hairlines between them by default.",
    },
    ListItem: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().nullable(),
        leading: z.string().nullable(),
        trailing: z.string().nullable(),
        selected: z.boolean().nullable(),
      }),
      slots: [],
      description: "A row with a title, optional subtitle, a leading emoji or initial, and trailing text. Emits press when bound with on.press.",
    },
    Table: {
      props: z.object({
        columns: z.array(z.union([z.string(), z.object({ key: z.string(), label: z.string(), align: z.enum(["start", "end"]).nullable() })])),
        rows: z.array(z.union([z.array(z.union([z.string(), z.number(), z.null()])), z.record(z.string(), z.unknown())])),
      }),
      slots: [],
      description: "Rows and columns of short values. rows are arrays of cells, or objects keyed by column key.",
    },
    BarChart: {
      props: z.object({
        data: z.array(z.object({ label: z.string(), value: z.number(), color: z.string().nullable() })),
        unit: z.string().nullable(),
        orientation: z.enum(["horizontal", "vertical"]).nullable(),
        height: z.number().nullable(),
      }),
      slots: [],
      description: "Bars comparing values: horizontal (default, labels left) or vertical columns.",
    },
    Sparkline: {
      props: z.object({ values: z.array(z.number()), height: z.number().nullable(), tone: tone.nullable() }),
      slots: [],
      description: "A tiny column chart of a series, for a trend beside a number.",
    },
    Image: {
      props: z.object({
        src: z.string(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        fit: z.enum(["contain", "cover"]).nullable(),
        radius: z.number().nullable(),
      }),
      slots: [],
      description: "A picture: an absolute file path or an https URL.",
    },
    Code: {
      props: z.object({ text: z.string() }),
      slots: [],
      description: "Monospace text in a box: commands, output, code.",
    },
    Avatar: {
      props: z.object({ name: z.string(), size: z.number().nullable() }),
      slots: [],
      description: "A round badge with a person's initials.",
    },
    Divider: { props: z.object({}), slots: [], description: "A hairline between groups." },
    Spacer: { props: z.object({}), slots: [], description: "Takes up the free space in a Stack, pushing siblings apart." },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["plain", "tinted", "filled", "danger"]).nullable(),
        size: z.enum(["small", "medium"]).nullable(),
        disabled: z.boolean().nullable(),
        block: z.boolean().nullable(),
      }),
      slots: [],
      description: "A button as wide as its label, or filling the width with block: true. Emits press.",
    },
    TextField: {
      props: z.object({
        value: z.string().nullable(),
        label: z.string().nullable(),
        placeholder: z.string().nullable(),
        multiline: z.boolean().nullable(),
      }),
      slots: [],
      description: 'A text input. Bind value with {"$bindState":"/path"}. Emits change and submit (Return).',
    },
    Switch: {
      props: z.object({ checked: z.boolean().nullable(), label: z.string().nullable() }),
      slots: [],
      description: 'An on/off switch with a label. Bind checked with $bindState. Emits change.',
    },
    Checkbox: {
      props: z.object({ checked: z.boolean().nullable(), label: z.string().nullable() }),
      slots: [],
      description: "A checkbox with a label. Bind checked with $bindState or $bindItem. Emits change.",
    },
    Slider: {
      props: z.object({
        value: z.number().nullable(),
        min: z.number().nullable(),
        max: z.number().nullable(),
        step: z.number().nullable(),
        label: z.string().nullable(),
        showValue: z.boolean().nullable(),
      }),
      slots: [],
      description: "A value dragged along a track. Bind value with $bindState. Emits change.",
    },
    Tabs: {
      props: z.object({
        options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])),
        value: z.string().nullable(),
      }),
      slots: [],
      description: "A segmented control choosing one of 2-5 options. Bind value with $bindState and show sections with visible conditions. Emits change.",
    },
    Countdown: {
      props: z.object({
        seconds: z.number().nullable(),
        until: z.union([z.string(), z.number()]).nullable(),
        running: z.boolean().nullable(),
        size: z.enum(["md", "lg", "xl"]).nullable(),
      }),
      slots: [],
      description: "A live mm:ss countdown from `seconds`, or to `until` (ISO time or epoch ms). It counts while `running` is true (the default): for Start and Pause buttons bind it, {\"running\":{\"$state\":\"/running\"}}, and set /running with setState. A Reset button runs resetTimer with the countdown's element key. Emits done at zero.",
    },
  },
  actions: {
    ask: {
      params: z.object({ text: z.string().nullable() }),
      description: 'Hand the UI back to the assistant. Params: { "text": "what to do" }. Your text plus the UI\'s whole state arrive as a message for you to act on (search, compute, update this UI).',
    },
    resetTimer: {
      params: z.object({ timer: z.string() }),
      description: 'Put a Countdown back to its seconds, stopped (a running read from state is set to false). Params: { "timer": "<the Countdown element\'s key>" }; without it, every Countdown in the UI.',
    },
    close: { params: z.object({}), description: "Close this UI." },
    copy: { params: z.object({ text: z.string() }), description: 'Put text on the clipboard. Params: { "text": "…" }.' },
  },
});

export type ComponentName = keyof typeof catalog.data.components;

/**
 * The system prompt section teaching a model this catalog and the spec format,
 * for a model that writes specs as the JSON patch list of a tool call (TOOL)
 * rather than as text.
 */
export function catalogPrompt(tool = "ui_render"): string {
  let prompt = catalog.prompt({ mode: "standalone" });
  prompt = prompt.replace(/^You are a UI generator that outputs JSON\.\s*/, "");
  prompt = prompt.replace(
    /OUTPUT FORMAT \(JSONL, RFC 6902 JSON Patch\):\n[^\n]*\n[^\n]*\n/,
    `UI FORMAT (RFC 6902 JSON Patch):\nA UI is a json-render spec built by JSON Patch operations, which you send as the \`patches\` list of the ${tool} tool, one operation object per item, never in your reply text. Start with /root, then send /elements and /state operations interleaved, so the UI fills in progressively while you write.\nTo change a UI you already made, call ${tool} again with the same id and only the operations that change it (replace an element, add one, set state).\n`,
  );
  prompt = prompt.replace("Example output (each line is a separate JSON object):", "Example patches (each line is one item of the list):");
  prompt = prompt.replace(/1\. Output ONLY JSONL patches[^\n]*\n/, `1. Patches go only in ${tool}'s patches list; your reply text stays prose\n`);
  return prompt;
}
