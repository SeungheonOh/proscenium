/**
 * Screen sharing: a chooser for each portal request, and the area selection it
 * can start.
 */

import { useMemo, useState } from "react";
import {
  acceptShare,
  Box,
  cancelShare,
  scale,
  Screen,
  useOutputs,
  useShares,
  useWindows,
  Web,
  type ShareInfo,
} from "proscenium";
import { useFrozen, useRetained } from "../hooks/useFrozen.js";
import { glassBorder, motion } from "../lib/theme.js";
import pickerPage from "../pages/share-picker/index.tsx?url";
import type { SharePickerMessage, SharePickerProps } from "../pages/share-picker/index.js";
import { AreaSelection, type OutputArea } from "./AreaSelection.js";

const pickerWidth = 460;

/** Asks about the oldest pending request, centered on the first output. */
export function ShareChooser() {
  const shares = useShares();
  const windows = useWindows();
  const outputs = useOutputs();
  const pending = shares.find((share) => share.source === null) ?? null;
  const request = useRetained<ShareInfo>(pending);
  const [selectingArea, setSelectingArea] = useState<number | null>(null);
  const open = pending !== null && selectingArea !== pending.id;

  const liveProps = useMemo<SharePickerProps>(
    () => ({
      app: request?.app,
      types: request?.types,
      request: request?.id,
      outputs: outputs.map((output) => output.name),
      windows: windows.map((window) => ({ id: window.id, title: window.title, app: window.appId })),
    }),
    [request, outputs, windows],
  );
  // A closed picker keeps what it showed, so window changes never reach the hidden page.
  const props = useFrozen(liveProps, !open);

  const output = outputs[0];
  if (!output) return null;

  const windowChoices = props.types?.includes("window") ? (props.windows?.length ?? 0) : 0;
  const screenChoices = props.types?.includes("screen") ? (props.outputs?.length ?? 0) : 0;
  const height = Math.min(520, 150 + 52 * (windowChoices + screenChoices));

  function handleMessage(message: SharePickerMessage) {
    if (!pending) return;
    switch (message.name) {
      case "window":
        return acceptShare(pending.id, { window: message.value });
      case "screen":
        return acceptShare(pending.id, { output: message.value });
      case "area":
        return setSelectingArea(pending.id);
      case "cancel":
        return cancelShare(pending.id);
    }
  }

  function handleArea(area: OutputArea | null) {
    setSelectingArea(null);
    if (!pending || !area) return;
    const { output: name, ...region } = area;
    acceptShare(pending.id, { output: name, region });
  }

  return (
    <>
      <Screen output={output.name}>
        <Box
          width={output.width}
          height={output.height}
          justifyContent="center"
          alignItems="center"
          fill="#0000004d"
          opacity={open ? 1 : 0}
          transition={motion.pop}
        >
          <Web
            src={pickerPage}
            props={props}
            autoFocus
            interactive={open}
            width={pickerWidth}
            height={height}
            radius={16}
            blur={24}
            border={glassBorder}
            shadow={{ color: "#00000040", blur: 48, y: 16 }}
            opacity={open ? 1 : 0}
            transform={scale(open ? 1 : 0.95)}
            transition={motion.pop}
            onMessage={(name, value) => handleMessage({ name, value } as SharePickerMessage)}
          />
        </Box>
      </Screen>
      {pending && selectingArea === pending.id && (
        <AreaSelection
          prompt="Drag to choose the area to share · Esc to go back"
          onDone={handleArea}
        />
      )}
    </>
  );
}
