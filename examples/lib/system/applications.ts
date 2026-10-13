import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { launch } from "proscenium";
import { debounced, Source } from "./source.js";

/** An installed application, from its desktop entry. */
export interface ApplicationInfo {
  /** The desktop file id, e.g. "org.gnome.Nautilus". */
  id: string;
  name: string;
  /** Its generic name or comment. */
  detail: string;
  /** Its icon: a theme icon name or a file path, or "". */
  icon: string;
  path: string;
}

function applicationDirectories(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const data = process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share";
  const roots = [home, ...data.split(":")].filter((root) => root.startsWith("/"));
  return [...new Set(roots)].map((root) => join(root, "applications"));
}

/** The [Desktop Entry] group of a desktop file. */
function desktopEntry(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      if (inside) break;
      inside = line.trim() === "[Desktop Entry]";
    } else if (inside && line.includes("=")) {
      const equals = line.indexOf("=");
      fields.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
    }
  }
  return fields;
}

async function scanApplications(): Promise<ApplicationInfo[]> {
  // Earlier directories win: a user's entry hides, or replaces, a system one with the same id.
  const seen = new Set<string>();
  const applications: ApplicationInfo[] = [];
  for (const directory of applicationDirectories()) {
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith(".desktop")).sort()) {
      const id = file.slice(0, -".desktop".length);
      if (seen.has(id)) continue;
      seen.add(id);
      const path = join(directory, file);
      const entry = desktopEntry(await readFile(path, "utf8").catch(() => ""));
      const name = entry.get("Name");
      if (entry.get("Type") !== "Application" || !name || !entry.get("Exec")) continue;
      if (entry.get("Hidden") === "true" || entry.get("NoDisplay") === "true") continue;
      applications.push({
        id,
        name,
        detail: entry.get("GenericName") ?? entry.get("Comment") ?? "",
        icon: entry.get("Icon") ?? "",
        path,
      });
    }
  }
  return applications.sort((left, right) => left.name.localeCompare(right.name));
}

const applications = new Source<ApplicationInfo[]>([], (source) => {
  const refresh = debounced(() => void scanApplications().then((found) => source.set(found)), 300);
  refresh();
  // Installing or removing an application changes its directory.
  const watchers: FSWatcher[] = [];
  for (const directory of applicationDirectories()) {
    try {
      watchers.push(watch(directory, refresh).on("error", () => undefined));
    } catch {
      // A directory that does not exist has nothing to watch.
    }
  }
  return () => watchers.forEach((watcher) => watcher.close());
});

/** Installed applications by name, kept current while anything reads them. */
export function useApplications(): readonly ApplicationInfo[] {
  return useSyncExternalStore(applications.subscribe, applications.read);
}

/** Launch an installed application by its id, as its desktop entry says. */
export function launchApplication(id: string): void {
  const application = applications.value.find((candidate) => candidate.id === id);
  if (application) launch(["gio", "launch", application.path]);
}
