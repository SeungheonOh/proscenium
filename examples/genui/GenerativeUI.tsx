/**
 * Generated interfaces and the assistant's chat, for any world:
 *
 *   Super+A      the assistant's chat, beside the right edge; again to put it away
 *
 * The world listens on $XDG_RUNTIME_DIR/proscenium-ui.sock (protocol.ts) for
 * programs that want interfaces: they send json-render specs and patches, get
 * the person's actions back, and own what they open until they disconnect. The
 * assistant (agent/) is one such program, a Pi agent started when the chat
 * first opens, which makes interfaces as it answers.
 *
 * Interfaces live in modes (Surfaces.tsx): in the chat, floating on the screen,
 * pinned over everything in a corner, docked along an edge, on the canvas, or as
 * a dialog. The person drags them between modes by their title bars.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Group, Shortcut, spring, useOutputs, usePersistentState } from "proscenium";
import { barLayout } from "../components/bar/layout.js";
import assistantMain from "./agent/main.ts?url";
import runner from "./run.mjs?url";
import { ChatPanel } from "./Chat.js";
import { startAssistant, UIHost } from "./host.js";
import { socketPath } from "./protocol.js";
import { GrabContext, HostContext } from "./SurfaceCard.js";
import { ScreenSurfaces, useGrabbing, WorldSurfaces, type Area, type Screenful } from "./Surfaces.js";

const chatWidth = 420;
const margin = 12;
const slide = spring({ duration: 0.4, bounce: 0.08 });

export function GenerativeUI() {
  const [host] = useState(() => new UIHost());
  const path = socketPath();
  useEffect(() => {
    host.listen(path);
    return () => host.close();
  }, [host, path]);
  const { surfaces, chat } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const output = useOutputs()[0];
  const screen: Screenful = { width: output?.width ?? 1280, height: output?.height ?? 720, top: barLayout.reserve,
                              output: output?.name };
  host.screen = { width: screen.width, height: screen.height };
  host.output = output?.name;

  const [chatOpen, setChatOpen] = usePersistentState("genui.chat", false);
  // A program already serving the chat (an assistant of the person's own) keeps it.
  useEffect(() => {
    if (chatOpen && !host.agentConnected) startAssistant(runner, assistantMain, path);
  }, [chatOpen]);

  const rightDock = surfaces.filter((entry) => entry.mode === "dock" && entry.place.side === "right")
    .reduce((most, entry) => Math.max(most, entry.width + margin), 0);
  const chatArea: Area = {
    x: screen.width - margin - chatWidth - rightDock, y: screen.top,
    width: chatWidth, height: screen.height - screen.top - margin,
  };
  const grab = useGrabbing(host, screen, chatOpen ? chatArea : null, surfaces);

  const panel = chatOpen && (
    <Group key="chat" initial={{ x: 40, opacity: 0 }} exit={{ x: 40, opacity: 0 }} transition={slide}>
      <ChatPanel host={host} chat={chat} surfaces={surfaces} area={chatArea} onClose={() => setChatOpen(false)} />
    </Group>
  );
  return (
    <HostContext.Provider value={host}>
      <GrabContext.Provider value={grab.grabbing}>
        <Shortcut keys="Super+A" onPress={() => setChatOpen((open) => !open)} />
        <WorldSurfaces surfaces={surfaces} dragging={grab.grabbing.dragging} output={screen.output} />
        <ScreenSurfaces surfaces={surfaces} screen={screen} chat={chatOpen ? chatArea : null} grab={grab} middle={panel} />
      </GrabContext.Provider>
    </HostContext.Provider>
  );
}

