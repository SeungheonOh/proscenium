/**
 * Generated interfaces and the assistant's chat, for any world:
 *
 *   Super+A      the assistant's chat, beside the right edge; again to put it away
 *
 * The world listens on $XDG_RUNTIME_DIR/proscenium-ui.sock (protocol.ts) for
 * programs that want interfaces: they send json-render specs and patches, get
 * the person's actions back, and own what they open until they disconnect. The
 * assistant (agent/) is one such program, a Pi agent started when the chat
 * first opens, which makes interfaces as it answers. Apps (apps.ts) are others,
 * which the world starts and keeps running: the ones running when it last
 * stopped start again with it.
 *
 * Interfaces live in modes (Surfaces.tsx): in the chat, floating on the screen,
 * pinned over everything in a corner, docked along an edge, on the canvas, or as
 * a dialog. The person drags them between modes by their title bars.
 */

import { dirname, join } from "node:path";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Group, Shortcut, useOutputs, usePersistentState } from "proscenium";
import { motion } from "proscenium/ui";
import { barLayout } from "../components/bar/layout.js";
import assistantMain from "./agent/main.ts?url";
import runner from "./run.mjs?url";
import { configureApps } from "./apps.js";
import { ChatPanel } from "./Chat.js";
import { startAssistant, UIHost } from "./host.js";
import { socketPath } from "./protocol.js";
import { GrabContext, HostContext } from "./SurfaceCard.js";
import { canvasCards, margin, ScreenSurfaces, useGrabbing, WorldSurfaces, type Area, type Screenful } from "./Surfaces.js";

const chatWidth = 420;
/** Below the bar, as far from it as everything keeps from the screen's edges. */
const top = barLayout.margin + barLayout.height + margin;

/**
 * Generated interfaces and the assistant's chat. BAR, the world's bar, is drawn between the
 * cards pinned to the canvas and those on the screen: in tree order, so canvas cards pass
 * under it as the camera moves, and screen cards, dialogs and drags stay over it.
 */
export function GenerativeUI({ bar }: { bar?: ReactNode } = {}) {
  const [host] = useState(() => new UIHost());
  const path = socketPath();
  useEffect(() => {
    host.listen(path);
    configureApps({ runner, socket: path, builtin: join(dirname(runner), "apps") });
    return () => host.close();
  }, [host, path]);
  const { surfaces, chat, apps } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const output = useOutputs()[0];
  const screen: Screenful = { width: output?.width ?? 1280, height: output?.height ?? 720, top, output: output?.name };
  host.screen = { width: screen.width, height: screen.height };
  host.output = output?.name;

  const [chatOpen, setChatOpen] = usePersistentState("genui.chat", false);
  // Whether an assistant was here: one that leaves is replaced after a moment, not at once.
  const wasConnected = useRef(false);
  if (chat.connected) wasConnected.current = true;
  // While the chat is open it has an assistant: the built-in one, unless another
  // program already serves it (an assistant of the person's own), or once that one leaves.
  useEffect(() => {
    if (!chatOpen || chat.connected) return;
    const timer = setTimeout(() => {
      if (!host.agentConnected) startAssistant(runner, assistantMain, path);
    }, wasConnected.current ? 1500 : 0);
    return () => clearTimeout(timer);
  }, [chatOpen, chat.connected]);

  const rightDock = surfaces.filter((entry) => entry.mode === "dock" && entry.place.side === "right")
    .reduce((most, entry) => Math.max(most, entry.width + margin), 0);
  const chatArea: Area = {
    x: screen.width - margin - chatWidth - rightDock, y: screen.top,
    width: chatWidth, height: screen.height - screen.top - margin,
  };
  const grab = useGrabbing(host, screen, chatOpen ? chatArea : null, surfaces);
  // A world's Super+drag reaches the cards pinned to its canvas through this.
  useEffect(() => {
    canvasCards.current = grab.carry;
    return () => { if (canvasCards.current === grab.carry) canvasCards.current = null; };
  }, [grab.carry]);

  const panel = chatOpen && (
    <Group key="chat" initial={{ x: 40, opacity: 0 }} exit={{ x: 40, opacity: 0 }} transition={motion.slide}>
      <ChatPanel host={host} chat={chat} surfaces={surfaces} apps={apps} area={chatArea} onClose={() => setChatOpen(false)} />
    </Group>
  );
  return (
    <HostContext.Provider value={host}>
      <GrabContext.Provider value={grab.grabbing}>
        <Shortcut keys="Super+A" onPress={() => setChatOpen((open) => !open)} />
        <WorldSurfaces surfaces={surfaces} grab={grab} output={screen.output} />
        {bar}
        <ScreenSurfaces surfaces={surfaces} screen={screen} chat={chatOpen ? chatArea : null} grab={grab} middle={panel} />
      </GrabContext.Provider>
    </HostContext.Provider>
  );
}

