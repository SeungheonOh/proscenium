/**
 * The application search on Super+R, rendered by Chromium. Type to filter by
 * the letters of a name in order, Up/Down to choose, Enter to launch, Escape
 * or a click beside the panel to close.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { send } from "proscenium/page";
import { afterPaint } from "../painted.js";
import "../fonts.js";
import "./search.css";

export interface SearchApplication {
  id: string;
  name: string;
  detail: string;
}

export interface SearchProps {
  applications?: readonly SearchApplication[];
  /** Icons by application, as data URLs: the ones last asked for, "" where there is none. */
  icons?: Readonly<Record<string, string>>;
  shown?: boolean;
}

export type SearchMessage =
  | { name: "launch"; value: string }
  | { name: "close" }
  /** Drawn for the first time, so it may be hidden until it is wanted. */
  | { name: "ready" }
  /** The applications whose rows show and whose icons the page lacks. */
  | { name: "icons"; value: readonly string[] };

const message = (value: SearchMessage) => send(value.name, "value" in value ? value.value : null);
const close = () => message({ name: "close" });
const row = 80;
const noIcons = {};

/** Whether NAME has the letters of QUERY in order. */
function matches(query: string, name: string): boolean {
  let at = 0;
  for (const letter of query) {
    at = name.indexOf(letter, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

export default function SearchPage({ applications = [], icons = noIcons, shown = false }: SearchProps) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [known, setKnown] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const needle = query.toLowerCase();
  const found = needle ? applications.filter((app) => matches(needle, app.name.toLowerCase())) : applications;

  useEffect(() => afterPaint(() => message({ name: "ready" })), []);
  useEffect(() => setKnown((previous) => ({ ...previous, ...icons })), [icons]);
  // Ask for the icons of the rows in view, and a few beyond, that it does not have yet.
  const first = Math.floor(scroll / row);
  const missing = found.slice(first, first + 12).map((app) => app.id).filter((id) => !(id in known));
  const asking = missing.join("\n");
  useEffect(() => {
    if (shown && missing.length) message({ name: "icons", value: missing });
  }, [shown, asking]);

  useEffect(() => {
    if (!shown) return;
    setQuery("");
    setCurrent(0);
    input.current?.focus();
  }, [shown]);
  // Keeps the chosen row in view by scrolling the list alone: scrollIntoView would scroll the page too,
  // taking the panel off screen for good.
  useEffect(() => {
    const box = list.current;
    const item = box?.children[current] as HTMLElement | undefined;
    if (!box || !item) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
    }
  }, [current]);

  const launch = (app: SearchApplication | undefined) => app && message({ name: "launch", value: app.id });

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowUp") setCurrent((index) => Math.max(0, index - 1));
    else if (event.key === "ArrowDown") setCurrent((index) => Math.min(found.length - 1, index + 1));
    else if (event.key === "Enter") launch(found[current]);
    else return;
    event.preventDefault();
  }

  if (!shown) return null;
  return (
    <div className="search" onClick={close}>
      <div className="slant frame" />
      <div className="slant fill" />
      <div className="panel" onClick={(event) => event.stopPropagation()}>
        <div className="header">
          <div className="apps">APPS</div>
          <div className="field">
            <input
              ref={input}
              value={query}
              placeholder="Search..."
              onChange={(event) => {
                setQuery(event.target.value);
                setCurrent(0);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>
        <div className="rule" />
        <div ref={list} className="list" onScroll={(event) => setScroll(event.currentTarget.scrollTop)}>
          {found.map((app, index) => (
            <div
              key={app.id}
              className={`app${index === current ? " current" : ""}`}
              onMouseEnter={() => setCurrent(index)}
              onClick={() => launch(app)}
            >
              <div className="icon">
                {known[app.id] ? <img src={known[app.id]} /> : app.name.charAt(0).toUpperCase()}
              </div>
              <div className="text">
                <div className="name">{app.name}</div>
                <div className="detail">{app.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
