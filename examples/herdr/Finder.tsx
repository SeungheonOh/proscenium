// The finder overlay (pages/finder): Projectile for the pane's project, over
// everything, centered. It stays mounted, so it opens at once; autoFocus gives
// it the keyboard whenever it shows.

import { Rect, scale, spring, Web, type OutputInfo } from "proscenium";
import finderPage from "../pages/finder/index.tsx?url";
import type { FinderMode, FinderProject, FinderProps } from "../pages/finder/index.js";
import { usePageChannel } from "./channel.js";
import { UiScreen } from "./UiScale.js";
import { grepProject, listDirectories, listFiles } from "./files.js";

export type { FinderMode, FinderProject };

/** Where the finder sends you: a file of the project (at a line), another pane, or a new workspace's directory. */
export type FinderTarget =
  | { path: string; line?: number; column?: number; length?: number }
  | { pane: string }
  | { directory: string };

const appear = spring({ duration: 0.22 });

interface FinderOverlayProps {
  output: OutputInfo;
  open: { mode: FinderMode; opened: number } | null;
  root: string | null;
  recent: string[];
  projects: FinderProject[];
  onGo: (target: FinderTarget) => void;
  onClose: () => void;
}

export function FinderOverlay({ output, open, root, recent, projects, onGo, onClose }: FinderOverlayProps) {
  const channel = usePageChannel(async (action, args) => {
    // Directories are anyone's, so asked without a project.
    if (action === "dirs") return listDirectories(String(args.path ?? ""));
    if (!root || args.root !== root) throw new Error("stale request");
    if (action === "list") return listFiles(root);
    if (action === "grep") return grepProject(root, String(args.pattern ?? ""));
    throw new Error(`unknown request ${action}`);
  });
  const width = Math.min(760, output.width - 40);
  const height = Math.min(480, output.height - 80);
  const props: FinderProps = {
    shown: open !== null,
    mode: open?.mode ?? "files",
    opened: open?.opened ?? 0,
    root: root ?? "",
    title: root?.split("/").pop() ?? "",
    recent,
    projects,
    reply: channel.reply,
  };
  return (
    <UiScreen output={output.name}>
      {/* Solid behind the page, so nothing under the finder shows through while it fades. */}
      <Rect x={(output.width - width) / 2} y={Math.max(20, output.height * 0.1)} width={width} height={height}
            fill="#ffffff" interactive={false} opacity={open ? 1 : 0} transform={scale(open ? 1 : 0.97)}
            transition={appear} />
      <Web
        src={finderPage}
        props={props}
        autoFocus
        interactive={open !== null}
        x={(output.width - width) / 2}
        y={Math.max(20, output.height * 0.1)}
        width={width}
        height={height}
        border={{ width: 1, color: "#0969da66" }}
        opacity={open ? 1 : 0}
        transform={scale(open ? 1 : 0.97)}
        transition={appear}
        onMessage={(name, value) => {
          if (channel.onMessage(name, value)) return;
          if (name === "go") onGo(value as FinderTarget);
          else if (name === "close") onClose();
        }}
      />
    </UiScreen>
  );
}
