import type { OutputInfo } from "proscenium";
import { Pills } from "../components/bar/Pills.js";
import { useHypr } from "./HyprProvider.js";
import { workspaceNumbers } from "./tiling.js";

/** The bar's workspaces: the shown one a wide accent pill, occupied ones darker dots. */
export function WorkspacePills({ output }: { output: OutputInfo }) {
  const { state, present, workspaceOf, switchTo } = useHypr();
  const occupied = new Set([...present].map((id) => state.workspaces[id]!));
  return <Pills items={workspaceNumbers} shown={workspaceOf(output)} occupied={occupied} onPick={switchTo} />;
}
