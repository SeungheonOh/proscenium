/**
 * The herdr world's code viewer: a project as a file tree, and the chosen file
 * in CodeMirror (Editor.tsx), or its diff against HEAD. The world reads the
 * disk for it (herdr/files.ts), answering requests over channel.ts; props say
 * which project and file to show, and `seq` changes whenever the project may
 * have changed, so the page looks again. Choosing a file sends `open`, and the
 * world passes the choice back as `path`; folding the tree away sends `tree`,
 * and the world passes it back as `treeOpen`.
 */

import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx, sendMessage } from "../shared.js";
import { useWorldChannel, type Reply } from "./channel.js";
import { Editor } from "./Editor.js";
import { Markdown } from "./Markdown.js";
import "./code-viewer.css";

export interface CodeViewerProps {
  reply?: Reply | null;
  root?: string;
  title?: string;
  seq?: number;
  path?: string | null;
  treeOpen?: boolean;
  /** A place in a file the finder jumped to. */
  jump?: { path: string; line?: number; column?: number; length?: number; seq: number } | null;
}

interface Listing {
  files: string[];
  changes: Record<string, string>;
  truncated: boolean;
}

interface OpenFile {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** A file that breaks the editor or the preview shows why, and the rest of the viewer stays. */
class Contained extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    const { error } = this.state;
    return error ? <pre className="crash">{`This file could not be shown.\n\n${error.stack ?? error.message}`}</pre> : this.props.children;
  }
}

interface Directory {
  name: string;
  path: string;
  directories: Map<string, Directory>;
  files: string[];
}

function buildTree(files: readonly string[]): Directory {
  const root: Directory = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let next = directory.directories.get(part);
      if (!next) {
        next = { name: part, path: directory.path ? `${directory.path}/${part}` : part, directories: new Map(), files: [] };
        directory.directories.set(part, next);
      }
      directory = next;
    }
    directory.files.push(file);
  }
  return root;
}

/** Every directory above PATH, which must be open for PATH to show. */
function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Narrower than this, the tree steps aside on its own so the code keeps room. */
const roomForTree = 560;

function useWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export default function CodeViewer({ reply = null, root = "", title = "", seq = 0, path = null, treeOpen: wantTree = true, jump = null }: CodeViewerProps) {
  const width = useWidth();
  const narrow = width < roomForTree;
  // Narrow, the tree opens over the code as a drawer, and closes once a file is chosen.
  const [drawer, setDrawer] = useState(false);
  const treeOpen = narrow ? drawer : wantTree;
  const request = useWorldChannel(reply);
  const [listing, setListing] = useState<Listing & { root: string } | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const files = listing?.root === root ? listing.files : [];
  const changes = listing?.root === root ? listing.changes : {};
  const truncated = listing?.truncated ?? false;
  const loading = listing?.root !== root;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [changedOnly, setChangedOnly] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [source, setSource] = useState(false);
  // The tree's right-click menu: what it is for and where it opened.
  const [menu, setMenu] = useState<{ path: string; directory: boolean; x: number; y: number } | null>(null);
  const [filter, setFilter] = useState("");

  const changed = Object.keys(changes).sort();
  // A deleted file has nothing but its diff to show.
  const diffing = showDiff || (path !== null && changes[path] === "D");

  // The tree, again whenever the session moves on; a burst of events fetches once.
  useEffect(() => {
    if (!root) return;
    let current = true;
    const timer = setTimeout(() => {
      request<Listing>("list", { root }).then(
        (next) => current && (setListing({ ...next, root }), setFailure(null)),
        (error: Error) => current && setFailure(error.message),
      );
    }, listing?.root === root ? 300 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, seq]);

  // The chosen file, and its diff while the diff shows.
  useEffect(() => {
    if (!root || !path) {
      setFile(null);
      setOriginal(null);
      return;
    }
    let current = true;
    Promise.all([
      request<OpenFile>("file", { root, path }),
      diffing ? request<string>("original", { root, path }) : null,
    ]).then(
      ([next, head]) => {
        if (!current) return;
        setFile(next);
        setOriginal(head);
        setFailure(null);
      },
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [root, path, seq, diffing]);

  // A new worktree starts with the directories of its changes open, once its tree arrives.
  useEffect(() => {
    setOpen(new Set([...changed, ...(path ? [path] : [])].flatMap(ancestors)));
    setFilter("");
    setShowDiff(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.root]);

  useEffect(() => {
    if (file) setOpen((current) => new Set([...current, ...ancestors(file.path)]));
  }, [file?.path]);

  const shown = useMemo(() => {
    const needle = filter.toLowerCase();
    const base = changedOnly ? changed : files;
    return needle ? base.filter((path) => path.toLowerCase().includes(needle)) : base;
  }, [files, changes, changedOnly, filter]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  // While filtering, every directory with a match is open.
  const isOpen = (path: string) => Boolean(filter) || open.has(path);

  function choose(next: string) {
    setDrawer(false);
    if (!(next in changes)) setShowDiff(false);
    sendMessage({ name: "open", value: next });
  }

  function toggle(path: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Hands PATH (a file, or with REVEAL the folder holding it) to the desktop's default app, through xdg-open. */
  const external = (path: string, reveal = false) => sendMessage({ name: "external", value: { path, reveal } });

  function openMenu(event: React.MouseEvent, path: string, directory: boolean) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ path, directory, x: event.clientX, y: event.clientY });
  }

  function renderDirectory(directory: Directory, depth: number): React.ReactNode[] {
    const rows: React.ReactNode[] = [];
    for (const child of [...directory.directories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const expanded = isOpen(child.path);
      const dirty = changed.some((path) => path.startsWith(`${child.path}/`));
      rows.push(
        <div key={`d:${child.path}`} className="row dir" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(child.path)}
             onContextMenu={(event) => openMenu(event, child.path, true)}>
          <span className="twisty">{expanded ? "▾" : "▸"}</span>
          <span className="name">{child.name}</span>
          {dirty && <span className="dot" />}
          <button className="more" title="Menu" onClick={(event) => openMenu(event, child.path, true)}>⋯</button>
        </div>,
      );
      if (expanded) rows.push(...renderDirectory(child, depth + 1));
    }
    for (const path of directory.files) {
      const change = changes[path];
      rows.push(
        <div
          key={`f:${path}`}
          className={cx("row file", file?.path === path && "chosen", change && `change-${change === "?" ? "U" : change}`)}
          style={{ paddingLeft: 20 + depth * 12 }}
          onClick={() => choose(path)}
          onContextMenu={(event) => openMenu(event, path, false)}
          title={path}
        >
          <span className="name">{path.split("/").pop()}</span>
          {change && <span className="badge">{change === "?" ? "U" : change}</span>}
          <button className="more" title="Menu" onClick={(event) => openMenu(event, path, false)}>⋯</button>
        </div>,
      );
    }
    return rows;
  }

  const markdown = file !== null && !file.binary && /\.(md|markdown|mdx)$/i.test(file.path);
  const previewing = markdown && !source && !diffing;
  const image = (target: string) => request<string>("image", { root, path: target });

  // Projectile's keys, wherever the page has the keyboard: the finder is the world's, over everything.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
      if (!event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) sendMessage({ name: "finder", value: "files" });
      else if (key === "f" && event.shiftKey) sendMessage({ name: "finder", value: "grep" });
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const setTree = (next: boolean) => (narrow ? setDrawer(next) : sendMessage({ name: "tree", value: next }));

  return (
    <div className="viewer" onClick={() => menu && setMenu(null)}>
      <aside className={cx("tree", !treeOpen && "folded", narrow && "drawer")}>
        <header>
          <div className="title-row">
            <div className="project" title={root} onContextMenu={(event) => openMenu(event, "", true)}>
              {title || root.split("/").pop()}
            </div>
            <button className="icon" title="Hide the file tree" onClick={() => setTree(false)}>«</button>
          </div>
          <input
            className="filter"
            placeholder="Filter files"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter("");
              if (event.key === "Enter" && shown[0]) choose(shown[0]);
            }}
          />
          <div className="toggles">
            <button className={cx(!changedOnly && "on")} onClick={() => setChangedOnly(false)}>
              All <span>{files.length}{truncated ? "+" : ""}</span>
            </button>
            <button className={cx(changedOnly && "on")} onClick={() => setChangedOnly(true)}>
              Changes <span>{changed.length}</span>
            </button>
          </div>
        </header>
        <div className="rows">{renderDirectory(tree, 0)}</div>
      </aside>
      <section className="code">
        <header>
          {!treeOpen && (
            <button className="icon" title="Show the file tree" onClick={() => setTree(true)}>»</button>
          )}
          <span className="path">{failure ? failure : file ? file.path : loading ? "Loading…" : "Choose a file"}</span>
          {file?.truncated && <span className="note">first 512 KB</span>}
          {file && (
            <button className="icon" title="Open with the default app (xdg-open)" onClick={() => external(file.path)}>↗</button>
          )}
          <button className="icon" title="Find a file (Ctrl+P); search the project (Ctrl+Shift+F)"
                  onClick={() => sendMessage({ name: "finder", value: "files" })}>⌕</button>
          {markdown && !diffing && (
            <button className={cx("diff-toggle", !source && "on")} onClick={() => setSource(!source)}>
              {source ? "Source" : "Preview"}
            </button>
          )}
          {file && file.path in changes && (
            <button className={cx("diff-toggle", showDiff && "on")} onClick={() => setShowDiff(!showDiff)}>
              Diff
            </button>
          )}
        </header>
        <div className="scroll">
          <Contained resetKey={`${file?.path}|${previewing}|${diffing}`}>
          {previewing ? (
            <Markdown path={file.path} content={file.content} image={image} open={choose} />
          ) : file && !file.binary ? (
            <Editor path={file.path} content={file.content}
                    original={diffing && original !== null ? original : null}
                    jump={jump && jump.path === file.path ? jump : null} />
          ) : file ? (
            <div className="empty">
              <div className="binary">
                <span>{file.content || "Not text: the viewer cannot show it."}</span>
                <button className="diff-toggle on" onClick={() => external(file.path)}>Open with default app</button>
              </div>
            </div>
          ) : (
            <div className="empty">
              {changed.length ? `${changed.length} changed file${changed.length === 1 ? "" : "s"} in this session` : "No changes yet"}
            </div>
          )}
          </Contained>
        </div>
      </section>
      {menu && (
        <div className="menu" style={{ left: Math.min(menu.x, width - 232), top: menu.y }}
             onClick={(event) => event.stopPropagation()}>
          <div className="menu-title">{menu.directory ? "Folder" : "File"} · {menu.path || title || "project"}</div>
          {!menu.directory && <button onClick={() => { setMenu(null); choose(menu.path); }}>Open here</button>}
          <button onClick={() => { setMenu(null); external(menu.path); }}>
            {menu.directory ? "Open folder" : "Open with default app"}
          </button>
          {!menu.directory && (
            <button onClick={() => { setMenu(null); external(menu.path, true); }}>Show in folder</button>
          )}
          <button onClick={() => { setMenu(null); sendMessage({ name: "copy", value: menu.path }); }}>Copy path</button>
        </div>
      )}
    </div>
  );
}
