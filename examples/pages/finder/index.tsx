/**
 * The herdr world's finder, after Emacs' Projectile: jump to a file of the
 * pane's project by fuzzy name, search the project's text with ripgrep, or
 * switch to another pane's project, or open a directory as a new herdr
 * workspace. Tab cycles the four; Enter goes; Escape or C-g closes; Up/Down or
 * C-n/C-p move. In files, "name:42" goes to line 42. In workspace, a typed
 * path ("~/src/", "/srv/") lists what is in it, and C-l completes the chosen one.
 *
 * The world answers `list`, `grep` and `dirs` over the code viewer's channel,
 * and is told where to go with `go`: {path, line?, column?, length?}, {pane}
 * or {directory}.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, sendMessage } from "../shared.js";
import { useWorldChannel, type Reply } from "../code-viewer/channel.js";
import "./finder.css";

export type FinderMode = "files" | "grep" | "projects" | "workspace";

export interface FinderProject {
  key: string;
  title: string;
  directory: string;
  status: string;
}

export interface FinderProps {
  shown?: boolean;
  mode?: FinderMode;
  /** Moves with each opening, which starts afresh. */
  opened?: number;
  root?: string;
  title?: string;
  recent?: string[];
  projects?: FinderProject[];
  reply?: Reply | null;
}

interface Listing {
  files: string[];
  changes: Record<string, string>;
  truncated: boolean;
}

interface Hit {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

const modes: { mode: FinderMode; label: string; hint: string }[] = [
  { mode: "files", label: "Files", hint: "Find a file  (name:line goes to a line)" },
  { mode: "grep", label: "Search", hint: "Search the project with ripgrep (regex, smart case)" },
  { mode: "projects", label: "Projects", hint: "Switch to another pane's project" },
  { mode: "workspace", label: "Workspace", hint: "Open a directory as a new workspace  (or type a path: ~/src/…)" },
];

/** A query naming a path rather than fuzzy-matching one. */
const isPath = (query: string) => /^(~|\/|\.\.?\/)/.test(query);

const maxShown = 80;

/**
 * Scores CANDIDATE against the fuzzy QUERY: every query character in order,
 * favouring runs, starts of words and the file name. Null when it does not match.
 */
function fuzzy(query: string, candidate: string): { score: number; marks: number[] } | null {
  if (!query) return { score: 0, marks: [] };
  const lower = candidate.toLowerCase();
  const nameStart = candidate.lastIndexOf("/") + 1;
  const marks: number[] = [];
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const char of query.toLowerCase()) {
    if (char === " ") continue;
    const found = lower.indexOf(char, at);
    if (found < 0) return null;
    const before = candidate[found - 1];
    let gain = 1;
    if (found === previous + 1) gain += 5;
    if (found === 0 || before === "/" || before === "_" || before === "-" || before === "." ||
        (before && before === before.toLowerCase() && candidate[found] !== candidate[found].toLowerCase())) gain += 4;
    if (found >= nameStart) gain += 2;
    score += gain - Math.min(3, (found - at) * 0.05);
    marks.push(found);
    previous = found;
    at = found + 1;
  }
  // Shorter paths and exact name hits rise.
  if (candidate.slice(nameStart).toLowerCase().startsWith(query.toLowerCase())) score += 10;
  return { score: score - candidate.length * 0.01, marks };
}

function Marked({ text, marks, offset = 0 }: { text: string; marks: readonly number[]; offset?: number }) {
  if (!marks.length) return <>{text}</>;
  const set = new Set(marks.map((mark) => mark - offset));
  const out: ReactNode[] = [];
  let run = "";
  let marking = false;
  for (let index = 0; index <= text.length; index++) {
    const isMark = set.has(index);
    if (index === text.length || isMark !== marking) {
      if (run) out.push(marking ? <mark key={index}>{run}</mark> : run);
      run = "";
      marking = isMark;
    }
    if (index < text.length) run += text[index];
  }
  return <>{out}</>;
}

export default function Finder({
  shown = false, mode: openedMode = "files", opened = 0, root = "", title = "", recent = [], projects = [], reply = null,
}: FinderProps) {
  const request = useWorldChannel(reply);
  const [mode, setMode] = useState<FinderMode>(openedMode);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [listing, setListing] = useState<(Listing & { root: string }) | null>(null);
  const [grep, setGrep] = useState<{ query: string; hits: Hit[]; truncated: boolean; error: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  // The directories on offer: zoxide's, or those where a typed path points.
  const [dirs, setDirs] = useState<{ path: string; base: string | null; directories: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Each opening starts afresh in the mode asked for, with the project's files read again.
  useEffect(() => {
    if (!shown) return;
    setMode(openedMode);
    setQuery("");
    setSelected(0);
    setGrep(null);
    setDirs(null);
    input.current?.focus();
    if (!root) return;
    let current = true;
    request<Listing>("list", { root }).then((next) => current && setListing({ ...next, root }), () => undefined);
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, opened]);

  // ripgrep runs once typing pauses.
  useEffect(() => {
    if (mode !== "grep" || !root) return;
    if (!query.trim()) {
      setGrep(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setSearching(true);
      request<{ hits: Hit[]; truncated: boolean }>("grep", { root, pattern: query }).then(
        (result) => current && setGrep({ query, ...result, error: null }),
        (error: Error) => current && setGrep({ query, hits: [], truncated: false, error: error.message }),
      ).finally(() => current && setSearching(false));
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, root]);

  // Directories are asked for again as a typed path moves to another directory.
  const dirsPath = mode === "workspace" && isPath(query) ? query.slice(0, query.lastIndexOf("/") + 1) || query : "";
  useEffect(() => {
    if (mode !== "workspace" || !shown) return;
    let current = true;
    const timer = setTimeout(() => {
      request<{ base: string | null; directories: string[] }>("dirs", { path: dirsPath }).then(
        (next) => current && setDirs({ path: dirsPath, ...next }),
        () => current && setDirs({ path: dirsPath, base: null, directories: [] }),
      );
    }, dirsPath ? 80 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dirsPath, shown, opened]);

  const files = listing?.root === root ? listing.files : [];
  const changes = listing?.root === root ? listing.changes : {};

  // "name:42" looks for name and goes to line 42.
  const lineMatch = mode === "files" ? /^(.*?):(\d+)$/.exec(query) : null;
  const fileQuery = lineMatch ? lineMatch[1] : query;
  const goLine = lineMatch ? Number(lineMatch[2]) : undefined;

  const fileResults = useMemo(() => {
    if (mode !== "files") return [];
    if (!fileQuery.trim()) {
      // Nothing typed: recent files, then the changed ones, then the rest.
      const seen = new Set<string>();
      const order = [...recent.filter((path) => files.includes(path)), ...Object.keys(changes).sort(), ...files];
      return order.filter((path) => !seen.has(path) && seen.add(path)).slice(0, maxShown)
        .map((path) => ({ path, marks: [] as number[], recent: recent.includes(path) }));
    }
    const scored: { path: string; marks: number[]; score: number; recent: boolean }[] = [];
    for (const path of files) {
      const match = fuzzy(fileQuery, path);
      if (match) scored.push({ path, ...match, recent: recent.includes(path), score: match.score + (path in changes ? 1 : 0) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, maxShown);
  }, [mode, fileQuery, files, changes, recent]);

  const projectResults = useMemo(() => {
    if (mode !== "projects") return [];
    return projects
      .map((project) => ({ project, match: fuzzy(query, `${project.title} ${project.directory}`) }))
      .filter((entry) => entry.match)
      .sort((a, b) => b.match!.score - a.match!.score);
  }, [mode, query, projects]);

  const directoryResults = useMemo(() => {
    if (mode !== "workspace") return [];
    if (isPath(query)) {
      // The typed path itself first, then what is beside it, by the name typed so far.
      const name = query.slice(query.lastIndexOf("/") + 1);
      const beside = dirs?.path === dirsPath ? dirs.directories : [];
      const matched = beside
        .map((directory) => ({ directory, match: fuzzy(name, directory.slice(directory.lastIndexOf("/") + 1)) }))
        .filter((entry) => entry.match && (name.startsWith(".") || !entry.directory.slice(entry.directory.lastIndexOf("/") + 1).startsWith(".")))
        .sort((a, b) => b.match!.score - a.match!.score)
        .slice(0, maxShown)
        .map(({ directory, match }) => ({
          directory, marks: match!.marks.map((mark) => mark + directory.lastIndexOf("/") + 1), typed: false, pane: false,
        }));
      return [{ directory: query, marks: [] as number[], typed: true, pane: false }, ...matched];
    }
    // The panes' directories, then zoxide's.
    const seen = new Set<string>();
    const panes = new Set(projects.map((project) => project.directory).filter(Boolean));
    const all = [...panes, ...(dirs?.path === "" ? dirs.directories : [])]
      .filter((directory) => !seen.has(directory) && seen.add(directory));
    return all
      .map((directory) => ({ directory, match: fuzzy(query, directory) }))
      .filter((entry) => entry.match)
      .sort((a, b) => (query ? b.match!.score - a.match!.score : 0))
      .slice(0, maxShown)
      .map(({ directory, match }) => ({ directory, marks: match!.marks, typed: false, pane: panes.has(directory) }));
  }, [mode, query, dirs, dirsPath, projects]);

  const hits = mode === "grep" ? grep?.hits ?? [] : [];
  const count = mode === "files" ? fileResults.length : mode === "grep" ? hits.length
    : mode === "projects" ? projectResults.length : directoryResults.length;
  const index = Math.min(selected, Math.max(0, count - 1));

  useEffect(() => setSelected(0), [mode, query]);
  useEffect(() => {
    list.current?.querySelector(".chosen")?.scrollIntoView({ block: "nearest" });
  }, [index, mode]);

  function go(at: number) {
    if (mode === "files" && fileResults[at]) {
      sendMessage({ name: "go", value: { path: fileResults[at].path, line: goLine } });
    } else if (mode === "grep" && hits[at]) {
      const hit = hits[at];
      sendMessage({ name: "go", value: { path: hit.path, line: hit.line, column: hit.column, length: hit.length } });
    } else if (mode === "projects" && projectResults[at]) {
      sendMessage({ name: "go", value: { pane: projectResults[at].project.key } });
    } else if (mode === "workspace" && directoryResults[at]) {
      sendMessage({ name: "go", value: { directory: directoryResults[at].directory } });
    }
  }

  function cycle(by: number) {
    const at = modes.findIndex((entry) => entry.mode === mode);
    setMode(modes[(at + by + modes.length) % modes.length].mode);
  }

  function onKeyDown(event: KeyboardEvent) {
    const ctrl = event.ctrlKey;
    const move = (by: number) => {
      event.preventDefault();
      setSelected(Math.max(0, Math.min(count - 1, index + by)));
    };
    if (event.key === "Escape" || (ctrl && event.key === "g")) {
      event.preventDefault();
      sendMessage({ name: "close" });
    } else if (event.key === "Tab") {
      event.preventDefault();
      cycle(event.shiftKey ? -1 : 1);
    } else if (mode === "workspace" && ctrl && event.key === "l") {
      // Into the chosen directory, to pick one inside it.
      event.preventDefault();
      const chosen = directoryResults[index];
      if (chosen) setQuery(chosen.directory.endsWith("/") ? chosen.directory : `${chosen.directory}/`);
    } else if (event.key === "ArrowDown" || (ctrl && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) move(-1);
    else if (event.key === "PageDown" || (ctrl && event.key === "v")) move(10);
    else if (event.key === "PageUp") move(-10);
    else if (event.key === "Enter" || (ctrl && event.key === "j")) {
      event.preventDefault();
      go(index);
    }
  }

  // Grep hits grouped under their file, as Projectile's search buffer shows them.
  let lastPath = "";

  return (
    <div className="finder">
      <div className="bar">
        <div className="modes">
          {modes.map((entry) => (
            <button key={entry.mode} className={cx(entry.mode === mode && "on")} tabIndex={-1}
                    onMouseDown={(event) => { event.preventDefault(); setMode(entry.mode); }}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="project">
          {mode === "projects" ? `${projects.length} panes` : mode === "workspace" ? "new herdr workspace" : title}
        </span>
      </div>
      <div className="query">
        <span className="prompt">{{ grep: "rg", projects: "pane", workspace: "open", files: "find" }[mode]}</span>
        <input ref={input} value={query} spellCheck={false} placeholder={modes.find((entry) => entry.mode === mode)!.hint}
               onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown}
               onBlur={() => shown && setTimeout(() => input.current?.focus(), 0)} />
        {searching && <span className="spinner" />}
      </div>
      <div className="results" ref={list}>
        {mode === "files" && fileResults.map((result, at) => {
          const slash = result.path.lastIndexOf("/") + 1;
          const change = changes[result.path];
          return (
            <div key={result.path} className={cx("row", at === index && "chosen")}
                 onMouseMove={() => at !== index && setSelected(at)} onMouseDown={() => go(at)}>
              <span className="name"><Marked text={result.path.slice(slash)} marks={result.marks} offset={slash} /></span>
              <span className="dir"><Marked text={result.path.slice(0, slash)} marks={result.marks.filter((m) => m < slash)} /></span>
              <span className="tags">
                {result.recent && <span className="tag">recent</span>}
                {change && <span className={`tag change-${change === "?" ? "U" : change}`}>{change === "?" ? "U" : change}</span>}
              </span>
            </div>
          );
        })}
        {mode === "grep" && hits.map((hit, at) => {
          const header = hit.path !== lastPath ? hit.path : null;
          lastPath = hit.path;
          const text = hit.text;
          const lead = Math.max(0, hit.column - 60);
          return (
            <div key={`${hit.path}:${hit.line}:${at}`}>
              {header && <div className="file-head">{header}</div>}
              <div className={cx("row hit", at === index && "chosen")}
                   onMouseMove={() => at !== index && setSelected(at)} onMouseDown={() => go(at)}>
                <span className="line-no">{hit.line}</span>
                <span className="snippet">
                  {lead > 0 && "…"}
                  {text.slice(lead, hit.column).trimStart()}
                  <mark>{text.slice(hit.column, hit.column + hit.length)}</mark>
                  {text.slice(hit.column + hit.length, hit.column + hit.length + 200)}
                </span>
              </div>
            </div>
          );
        })}
        {mode === "projects" && projectResults.map(({ project }, at) => (
          <div key={project.key} className={cx("row", at === index && "chosen")}
               onMouseMove={() => at !== index && setSelected(at)} onMouseDown={() => go(at)}>
            <span className={`status status-${project.status}`} />
            <span className="name">{project.title}</span>
            <span className="dir">{project.directory}</span>
          </div>
        ))}
        {mode === "workspace" && directoryResults.map((result, at) => {
          const slash = result.directory.replace(/\/$/, "").lastIndexOf("/") + 1;
          return (
            <div key={`${result.typed}:${result.directory}`} className={cx("row", at === index && "chosen")}
                 onMouseMove={() => at !== index && setSelected(at)} onMouseDown={() => go(at)}>
              {result.typed ? (
                <span className="name">{result.directory}</span>
              ) : (
                <>
                  <span className="name"><Marked text={result.directory.slice(slash)} marks={result.marks} offset={slash} /></span>
                  <span className="dir"><Marked text={result.directory.slice(0, slash)} marks={result.marks.filter((m) => m < slash)} /></span>
                </>
              )}
              <span className="tags">
                {result.typed && <span className="tag">as typed</span>}
                {result.pane && <span className="tag">pane</span>}
              </span>
            </div>
          );
        })}
        {count === 0 && (
          <div className="empty">
            {mode === "grep"
              ? grep?.error ?? (query.trim() ? (searching ? "Searching…" : "No matches") : "Type to search the project")
              : mode === "files" ? (files.length ? "No file matches" : "Reading the project…")
              : mode === "workspace" ? (dirs ? "No directory matches: type a path, as ~/src/" : "Asking for directories…")
              : "No other panes"}
          </div>
        )}
      </div>
      <div className="foot">
        <span>{mode === "grep" && grep ? `${grep.hits.length}${grep.truncated ? "+" : ""} matches` : `${count} shown`}</span>
        <span>{mode === "workspace" ? "↵ open · C-l into · " : "↵ go · "}Tab mode · C-n/C-p move · Esc close</span>
      </div>
    </div>
  );
}
