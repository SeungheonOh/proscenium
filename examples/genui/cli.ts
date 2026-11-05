// proscenium-ui: interfaces from the shell, through the generated UI protocol.
//
//   proscenium-ui show SPEC.json [--mode M] [--anchor A] [--side S] [--title T] [--width N] [--theme dark]
//       Shows a json-render spec (a file, or - for stdin; a spec object, or JSON patch lines) and prints
//       what the person does as JSON lines until they close it.
//   proscenium-ui ask "QUESTION" [--choices "Yes,No"] [--input] [--placeholder P] [--title T]
//       Asks in a dialog; prints the choice or the text typed, and exits 1 if dismissed.
//   proscenium-ui notify "TEXT" [--title T] [--seconds 5] [--anchor top-right]
//       A note pinned over everything for a few seconds.
//   proscenium-ui catalog
//       Prints how to write specs for the components the world draws, for a model's prompt.

import { readFileSync } from "node:fs";
import { UIClient, type JsonPatch, type OpenOptions, type Spec } from "./client.js";
import type { Anchor, Mode } from "./protocol.js";

const [command, ...rest] = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const words: string[] = [];
for (let index = 0; index < rest.length; index++) {
  const word = rest[index]!;
  if (word.startsWith("--")) {
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) flags[word.slice(2)] = true;
    else flags[word.slice(2)] = rest[++index]!;
  } else {
    words.push(word);
  }
}
const flag = (name: string) => (typeof flags[name] === "string" ? flags[name] as string : undefined);

function usage(): never {
  console.error(`Usage:
  proscenium-ui show SPEC.json|- [--mode floating|overlay|dock|canvas|dialog] [--anchor A] [--side left|right]
                                 [--title T] [--width N] [--theme light|dark] [--id ID]
  proscenium-ui ask "QUESTION" [--choices "Yes,No"] [--input] [--placeholder P] [--title T]
  proscenium-ui notify "TEXT" [--title T] [--seconds 5] [--anchor top-right]
  proscenium-ui catalog`);
  process.exit(2);
}

/** A spec object, or the patches of JSON lines. */
function readSpec(source: string): Pick<OpenOptions, "spec" | "patches"> {
  const text = readFileSync(source === "-" ? 0 : source, "utf8").trim();
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return { patches: value as JsonPatch[] };
    return { spec: value as Partial<Spec> };
  } catch {
    return { patches: text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonPatch) };
  }
}

const ui = new UIClient({ name: flag("name") ?? "proscenium-ui", reconnect: false });
ui.on("disconnect", () => {
  console.error("proscenium-ui: the world went away");
  process.exit(3);
});

async function opened(id: string, options: OpenOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ui.once("connect", resolve);
    setTimeout(() => reject(new Error("No world is listening (is Proscenium running?)")), 3000);
  });
  const result = await ui.open(id, options);
  if (!result.ok) throw new Error(result.error);
  for (const problem of result.problems ?? []) console.error(`proscenium-ui: ${problem}`);
}

async function main(): Promise<void> {
  switch (command) {
    case "show": {
      const source = words[0];
      if (!source) usage();
      const id = flag("id") ?? "main";
      await opened(id, {
        ...readSpec(source), mode: (flag("mode") ?? "floating") as Mode, title: flag("title"),
        place: { anchor: flag("anchor") as Anchor | undefined, side: flag("side") as "left" | "right" | undefined },
        width: flag("width") ? Number(flag("width")) : undefined, theme: flag("theme") === "dark" ? "dark" : undefined,
      });
      for (const event of ["action", "state", "placed"] as const) ui.on(event, (message) => console.log(JSON.stringify(message)));
      ui.on("closed", (message) => {
        console.log(JSON.stringify(message));
        process.exit(0);
      });
      return;
    }
    case "ask": {
      const question = words.join(" ");
      if (!question) usage();
      const choices = String(flag("choices") ?? (flags.input ? "Cancel,OK" : "No,Yes")).split(",").map((choice) => choice.trim());
      const input = flags.input === true;
      const buttons = choices.map((choice, index) => [`choice${index}`, {
        type: "Button", children: [],
        props: { label: choice, variant: index === choices.length - 1 ? "filled" : "plain" },
        on: { press: { action: "choose", params: { choice, text: { $state: "/text" } } } },
      }] as const);
      await opened("ask", {
        mode: "dialog", title: flag("title") ?? "Question", width: 400,
        spec: {
          root: "root", state: { text: "" },
          elements: {
            root: { type: "Stack", props: { gap: "lg" }, children: ["question", ...(input ? ["field"] : []), "buttons"] },
            question: { type: "Text", props: { text: question, size: "lg" }, children: [] },
            field: { type: "TextField", props: { value: { $bindState: "/text" }, placeholder: flag("placeholder") ?? "" },
                     children: [], on: { submit: { action: "choose", params: { choice: choices.at(-1)!, text: { $state: "/text" } } } } },
            buttons: { type: "Stack", props: { direction: "horizontal", gap: "sm", justify: "end" },
                       children: buttons.map(([key]) => key) },
            ...Object.fromEntries(buttons),
          },
        },
      });
      ui.on("action", ({ params }) => {
        const choice = String(params.choice ?? "");
        // The first choice of an input question is its way out.
        if (input && choice === choices[0]) process.exit(1);
        console.log(input ? String(params.text ?? "") : choice);
        ui.close("ask");
        setTimeout(() => process.exit(0), 50);
      });
      ui.on("closed", () => process.exit(1));
      return;
    }
    case "notify": {
      const text = words.join(" ");
      if (!text) usage();
      await opened("note", {
        mode: "overlay", place: { anchor: (flag("anchor") ?? "top-right") as Anchor }, title: flag("title") ?? "Note",
        width: 300, spec: { root: "text", elements: { text: { type: "Markdown", props: { text }, children: [] } } },
      });
      setTimeout(() => {
        ui.close("note");
        setTimeout(() => process.exit(0), 50);
      }, Number(flag("seconds") ?? 5) * 1000);
      ui.on("closed", () => process.exit(0));
      return;
    }
    case "catalog": {
      await new Promise<void>((resolve) => ui.once("connect", resolve));
      console.log((await ui.catalog()).prompt);
      process.exit(0);
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(`proscenium-ui: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
