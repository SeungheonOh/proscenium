import { useMemo, useState } from "react";
import { Screen, Shortcut, Web } from "proscenium";
import { useHypr } from "../hypr/HyprProvider.js";
import { launchApplication, useApplications } from "../lib/system/applications.js";
import { iconData } from "./icons.js";
import searchPage from "./pages/search/index.tsx?url";
import type { SearchMessage, SearchProps } from "./pages/search/index.js";
import { usePersona } from "./PersonaProvider.js";

/** The application search down the left edge, on Super+R; it takes the keyboard while open. */
export function Search() {
  const { searching, setSearching } = usePersona();
  const { focusOutput } = useHypr();
  const applications = useApplications();
  const [wanted, setWanted] = useState<readonly string[]>([]);
  // Shown once, empty, at the start, so it opens at once when first wanted.
  const [ready, setReady] = useState(false);
  const entries = useMemo(() => applications.map(({ id, name, detail }) => ({ id, name, detail })), [applications]);
  // The icons the page asked for, as many as fit; "" for one there is none of.
  const icons = useMemo(() => {
    const found: Record<string, string> = {};
    let room = 52_000 - JSON.stringify(entries).length;
    for (const id of wanted) {
      const icon = iconData(applications.find((application) => application.id === id)?.icon ?? "");
      if (icon.length > room) continue;
      found[id] = icon;
      room -= icon.length;
    }
    return found;
  }, [wanted, applications]);
  const props: SearchProps = { applications: entries, icons, shown: searching };

  function handleMessage(message: SearchMessage) {
    if (message.name === "icons") {
      setWanted(message.value);
      return;
    }
    if (message.name === "ready") {
      setReady(true);
      return;
    }
    if (message.name === "launch") launchApplication(message.value);
    setSearching(() => false);
  }

  return (
    <>
      <Shortcut keys="Super+R" onPress={() => setSearching((open) => !open)} />
      {focusOutput && (
        <Screen output={focusOutput.name}>
          <Web
            src={searchPage}
            props={props}
            width={450}
            height={focusOutput.height}
            visible={searching || !ready}
            interactive={searching}
            autoFocus={searching}
            onMessage={(name, value) => handleMessage({ name, value } as SearchMessage)}
          />
        </Screen>
      )}
    </>
  );
}
