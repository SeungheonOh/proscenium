/** The screen-sharing chooser: a window, a whole screen, or an area. */

import { useEffect, useState } from "react";
import { sendMessage, stagger } from "../shared.js";
import { SourceOption } from "./SourceOption.js";
import "./share-picker.css";

export interface SharePickerProps {
  app?: string;
  types?: ("screen" | "window")[];
  windows?: { id: number; title: string; app: string }[];
  outputs?: string[];
  /** The request's id; each request starts from a fresh choice. */
  request?: number;
}

/** What the picker asks the world to do. */
export type SharePickerMessage =
  | { name: "window"; value: number }
  | { name: "screen"; value: string }
  | { name: "area" }
  | { name: "cancel" };

const sendPickerMessage: (message: SharePickerMessage) => void = sendMessage;

type Choice = { window: number } | { output: string };

function isSameChoice(a: Choice | null, b: Choice) {
  if (a === null) return false;
  if ("window" in a) return "window" in b && a.window === b.window;
  return "output" in b && a.output === b.output;
}

function share(choice: Choice) {
  if ("window" in choice) sendPickerMessage({ name: "window", value: choice.window });
  else sendPickerMessage({ name: "screen", value: choice.output });
}

export default function SharePickerPage({
  app = "",
  types = [],
  windows = [],
  outputs = [],
  request = 0,
}: SharePickerProps) {
  // A choice belongs to the request it was made for.
  const [selection, setSelection] = useState<{ request: number; choice: Choice } | null>(null);
  const choice = selection?.request === request ? selection.choice : null;
  const select = (next: Choice) => setSelection({ request, choice: next });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") sendPickerMessage({ name: "cancel" });
      else if (event.key === "Enter" && choice) share(choice);
    }
    addEventListener("keydown", handleKeyDown);
    return () => removeEventListener("keydown", handleKeyDown);
  }, [choice]);

  const screens = types.includes("screen") ? outputs : [];
  const shareableWindows = types.includes("window") ? windows : [];

  return (
    <div className="card" key={request}>
      <header className="rise">
        <h1>Share your screen</h1>
        <p className="muted">{app || "An application"} wants to see what you choose.</p>
      </header>

      <div className="list">
        {screens.length > 0 && (
          <h2 className="label rise" style={stagger(1)}>
            Screens
          </h2>
        )}
        {screens.map((output, index) => (
          <SourceOption
            key={output}
            index={2 + index}
            name="Entire screen"
            detail={output}
            thumbnail="▭"
            selected={isSameChoice(choice, { output })}
            onSelect={() => select({ output })}
            onChoose={() => share({ output })}
          />
        ))}

        {shareableWindows.length > 0 && (
          <h2 className="label rise" style={stagger(2 + screens.length)}>
            Windows
          </h2>
        )}
        {shareableWindows.map((window, index) => (
          <SourceOption
            key={window.id}
            index={3 + screens.length + index}
            name={window.title || "Untitled"}
            detail={window.app}
            thumbnail="▢"
            selected={isSameChoice(choice, { window: window.id })}
            onSelect={() => select({ window: window.id })}
            onChoose={() => share({ window: window.id })}
          />
        ))}
      </div>

      <footer className="footer">
        {types.includes("screen") && (
          <button onClick={() => sendPickerMessage({ name: "area" })}>Select area…</button>
        )}
        <div className="spacer" />
        <button onClick={() => sendPickerMessage({ name: "cancel" })}>Cancel</button>
        <button className="primary" disabled={!choice} onClick={() => choice && share(choice)}>
          Share
        </button>
      </footer>
    </div>
  );
}
