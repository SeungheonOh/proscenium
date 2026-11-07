// Line diffs for the Diff component: what changed between two texts, or what a
// unified diff (git diff output) says changed, as files of hunks of lines.

export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
  /** Its number in the old text (same and removed lines) and in the new one (same and added). */
  old?: number;
  new?: number;
}

export interface DiffHunk {
  /** Unchanged lines folded away before it, when known. */
  skipped?: number;
  /** What a unified diff's @@ line names after its numbers: the function it is in. */
  context?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path?: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** Lines of TEXT, with no empty last line for a text that ends in a newline. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The lines of BEFORE and AFTER in order, each the same, removed or added: the longest common run of lines kept. */
export function diffLines(before: string, after: string, startLine = 1): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // What both start and end with needs no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const middleA = a.slice(start, a.length - end);
  const middleB = b.slice(start, b.length - end);
  const ops: ("same" | "removed" | "added")[] = [];
  const n = middleA.length;
  const m = middleB.length;
  if (n * m > 2_000_000) {
    // Too big to compare line by line: all of the old, then all of the new.
    for (let index = 0; index < n; index++) ops.push("removed");
    for (let index = 0; index < m; index++) ops.push("added");
  } else {
    // Lengths of the longest common runs of the suffixes, then walked from the start.
    const table = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[at(i, j)] = middleA[i] === middleB[j] ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && middleA[i] === middleB[j]) {
        ops.push("same");
        i++;
        j++;
      } else if (j === m || (i < n && table[at(i + 1, j)]! >= table[at(i, j + 1)]!)) {
        // On a tie the removal goes first, as git shows them.
        ops.push("removed");
        i++;
      } else {
        ops.push("added");
        j++;
      }
    }
  }
  const lines: DiffLine[] = [];
  let oldNumber = startLine;
  let newNumber = startLine;
  for (let index = 0; index < start; index++) lines.push({ kind: "same", text: a[index]!, old: oldNumber++, new: newNumber++ });
  let ia = start;
  let ib = start;
  for (const op of ops) {
    if (op === "same") lines.push({ kind: "same", text: a[ia++]!, old: oldNumber++, new: (ib++, newNumber++) });
    else if (op === "removed") lines.push({ kind: "removed", text: a[ia++]!, old: oldNumber++ });
    else lines.push({ kind: "added", text: b[ib++]!, new: newNumber++ });
  }
  for (let index = a.length - end; index < a.length; index++) {
    lines.push({ kind: "same", text: a[index]!, old: oldNumber++, new: newNumber++ });
  }
  return lines;
}

/** LINES as hunks: the changes with CONTEXT unchanged lines around each, the stretches between folded. */
export function hunksOf(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((line, index) => (line.kind === "same" ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return lines.length ? [{ lines: lines.slice(0, Math.min(lines.length, context * 2)) }] : [];
  const hunks: DiffHunk[] = [];
  let from = Math.max(0, changed[0]! - context);
  let to = Math.min(lines.length, changed[0]! + context + 1);
  let shownTo = 0;
  const close = () => {
    hunks.push({ skipped: from - shownTo || undefined, lines: lines.slice(from, to) });
    shownTo = to;
  };
  for (const index of changed.slice(1)) {
    if (index - context <= to) to = Math.min(lines.length, index + context + 1);
    else {
      close();
      from = index - context;
      to = Math.min(lines.length, index + context + 1);
    }
  }
  close();
  const after = lines.length - shownTo;
  if (after > 0) hunks.push({ skipped: after, lines: [] });
  return hunks;
}

/** The change from BEFORE to AFTER as one file. */
export function diffTexts(before: string, after: string, options: { path?: string; startLine?: number; context?: number } = {}): DiffFile {
  const lines = diffLines(before, after, options.startLine ?? 1);
  return {
    path: options.path,
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks: hunksOf(lines, options.context ?? 3),
  };
}

/** The files of a unified diff, as `git diff` or `diff -u` prints it. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  let lastOld = 0;
  const begin = (path?: string) => {
    file = { path, added: 0, removed: 0, hunks: [] };
    files.push(file);
    hunk = undefined;
    lastOld = 0;
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      begin(/ b\/(.+)$/.exec(line)?.[1]);
      continue;
    }
    if (line.startsWith("--- ") && !hunk) {
      if (!file) begin();
      const path = line.slice(4).replace(/^a\//, "").replace(/\t.*$/, "");
      if (path !== "/dev/null") file!.path ??= path;
      continue;
    }
    if (line.startsWith("+++ ") && (!hunk || hunk.lines.length === 0)) {
      if (!file) begin();
      const path = line.slice(4).replace(/^b\//, "").replace(/\t.*$/, "");
      if (path !== "/dev/null") file!.path = path;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (header) {
      if (!file) begin();
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      hunk = { skipped: Math.max(0, oldNumber - 1 - lastOld) || undefined, context: header[3] || undefined, lines: [] };
      file!.hunks.push(hunk);
      continue;
    }
    // A hunk with no line numbers, as Codex's patches have: its lines go unnumbered.
    const bare = /^@@(?:\s+(.*))?$/.exec(line);
    if (bare) {
      if (!file) begin();
      oldNumber = newNumber = NaN;
      hunk = { context: bare[1] || undefined, lines: [] };
      file!.hunks.push(hunk);
      continue;
    }
    if (!hunk || !file) continue;
    const numbered = (value: number) => (Number.isNaN(value) ? undefined : value);
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "added", text: line.slice(1), new: numbered(newNumber++) });
      file.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "removed", text: line.slice(1), old: numbered(oldNumber++) });
      file.removed++;
      lastOld = oldNumber - 1;
    } else if (line.startsWith(" ") || line === "") {
      // A blank line at the very end is the patch's last newline, not a line of the file.
      if (line === "") continue;
      hunk.lines.push({ kind: "same", text: line.slice(1), old: numbered(oldNumber++), new: numbered(newNumber++) });
      lastOld = oldNumber - 1;
    }
  }
  return files;
}
