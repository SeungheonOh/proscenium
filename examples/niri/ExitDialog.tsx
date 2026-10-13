import { Box, Rect, scale, Screen, Text, useInput, useKeyboardGrab } from "proscenium";
import { motion } from "./config.js";
import { keyCap } from "./HotkeyOverlay.js";
import { useNiri } from "./NiriProvider.js";

/** Stops the compositor the way its session manager would, which ends the session. */
export function quit(): void {
  const parent = Number(process.env.PROSCENIUM_PARENT) || process.ppid;
  process.kill(parent, "SIGTERM");
}

/**
 * niri's exit confirmation: a red-bordered panel over a darkened screen that
 * springs open. Enter exits; any other input cancels, and no window sees it.
 */
export function ExitDialog() {
  const { outputs, overlays, setOverlay } = useNiri();
  const open = overlays.exit;
  const cancel = () => setOverlay("exit", false);
  useKeyboardGrab(open ? (event) => {
    if (!event.pressed) return;
    if (event.key === "Return" || event.key === "KP_Enter") quit();
    else cancel();
  } : null);
  useInput(open ? (event) => event.kind !== "key" && cancel() : null);
  return (
    <>
      {outputs.map((output) => (
        <Screen key={output.name} output={output.name}>
          <Rect
            width={output.width}
            height={output.height}
            fill="#00000066"
            opacity={open ? 1 : 0}
            visible={open}
            transition={motion.exitDialog}
            onPointerDown={cancel}
          />
          <Box
            width={output.width}
            height={output.height}
            justifyContent="center"
            alignItems="center"
            interactive={false}
          >
            <Box
              fill="#1a1a1a"
              border={{ width: 4, color: "#ff4d4d" }}
              padding={16}
              opacity={open ? 1 : 0}
              transform={[scale(open ? 1 : 0.8)]}
              transition={motion.exitDialog}
              interactive={false}
            >
              <Text markup font="sans" size={14} color="#ffffff" align="center">
                {`Are you sure you want to exit niri?\n\nPress ${keyCap("Enter", "#2c2c2c")} to confirm.`}
              </Text>
            </Box>
          </Box>
        </Screen>
      ))}
    </>
  );
}
