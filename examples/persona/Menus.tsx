import { useRef, useState } from "react";
import { launch, Screen, useOutputs, Web } from "proscenium";
import { useTime } from "../lib/system/clock.js";
import { quit } from "../lib/system/session.js";
import menusPage from "./pages/menus/index.tsx?url";
import type { MenusMessage, MenusProps, PowerAction } from "./pages/menus/index.js";
import { usePersona } from "./PersonaProvider.js";
import { useBluetooth, useNetworks, useSystemStats } from "./system.js";

function power(action: PowerAction) {
  if (action === "logout") quit();
  else launch(["loginctl", action === "shutdown" ? "poweroff" : "reboot"]);
}

/**
 * The drawer's menus on the output they were opened on. The page stays loaded
 * and hidden between them; it is hidden only once it has drawn nothing, so a
 * menu never opens on the last one's final frame. It shows once at the start,
 * empty, so Chromium is ready to draw the first menu at once.
 */
export function Menus() {
  const { menu, closeMenu, filter, setFilter } = usePersona();
  const outputs = useOutputs();
  const [showing, setShowing] = useState(true);
  const last = useRef<string | null>(null);
  if (menu) last.current = menu.output;
  const output = outputs.find((candidate) => candidate.name === last.current) ?? outputs[0];
  const stats = menu?.kind === "stats";
  const system = useSystemStats(stats);
  const networks = useNetworks(stats);
  const bluetooth = useBluetooth(stats);
  const now = useTime();
  if (!output) return null;

  const props: MenusProps = {
    menu: menu && { kind: menu.kind, serial: menu.serial },
    now: now.getTime(),
    stats: { system, networks, bluetooth },
    filter,
  };

  function handleMessage(message: MenusMessage) {
    if (message.name === "close") closeMenu();
    else if (message.name === "showing") setShowing(message.value);
    else if (message.name === "power") power(message.value);
    else setFilter(message.value);
  }

  return (
    <Screen output={output.name}>
      <Web
        src={menusPage}
        props={props}
        width={output.width}
        height={output.height}
        visible={menu !== null || showing}
        interactive={menu !== null}
        autoFocus={menu !== null}
        onMessage={(name, value) => handleMessage({ name, value } as MenusMessage)}
      />
    </Screen>
  );
}
