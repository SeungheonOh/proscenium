/**
 * The application launcher, rendered by Chromium.
 * Type to filter, Up/Down to choose, Enter to launch, Escape to close.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ApplicationInfo } from "../../lib/system/applications.js";
import { cx, sendMessage } from "../shared.js";
import "./launcher.css";

export interface LauncherProps {
  applications?: readonly ApplicationInfo[];
  shown?: boolean;
}

/** What the launcher asks the world to do. */
export type LauncherMessage = { name: "launch"; value: string } | { name: "close" };

const sendLauncherMessage: (message: LauncherMessage) => void = sendMessage;
const maxResults = 7;

export default function LauncherPage({ applications = [], shown = false }: LauncherProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const needle = query.toLowerCase();
  const matches = applications
    .filter((app) => `${app.name} ${app.detail}`.toLowerCase().includes(needle))
    .slice(0, maxResults);

  // Focus the search on opening, and clear it on closing so the old search
  // never shows while the launcher fades in.
  useEffect(() => {
    if (shown) {
      input.current?.focus();
    } else {
      setQuery("");
      setSelected(0);
    }
  }, [shown]);

  function launch(app: ApplicationInfo) {
    sendLauncherMessage({ name: "launch", value: app.id });
  }

  function handleKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "Escape":
        sendLauncherMessage({ name: "close" });
        break;
      case "ArrowDown":
        setSelected((index) => Math.min(index + 1, matches.length - 1));
        break;
      case "ArrowUp":
        setSelected((index) => Math.max(index - 1, 0));
        break;
      case "Enter":
        if (matches[selected]) launch(matches[selected]);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className="launcher">
      <input
        ref={input}
        className="search"
        value={query}
        placeholder="Search applications"
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <ul className="results">
        {matches.map((app, index) => (
          <li
            key={app.id}
            className={cx("result", index === selected && "selected")}
            onMouseEnter={() => setSelected(index)}
            onClick={() => launch(app)}
          >
            <div className="name">{app.name}</div>
            <div className="detail ellipsis">{app.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
