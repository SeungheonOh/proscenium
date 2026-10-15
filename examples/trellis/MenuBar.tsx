import { useState } from "react";
import { Box, Rect, Reserve, Screen, Spacer, Text, useFocusedWindow } from "proscenium";
import { useTime } from "../lib/system/clock.js";
import { sameTarget, type Target } from "./model.js";
import { showEverything } from "./navigation.js";
import { useTrellis } from "./TrellisProvider.js";

export const menuBarHeight = 28;

/**
 * The menu bar: the focused window on the left; on the right, back and forward
 * through where the view has been, the Desktop, everything, and the saved
 * views. The button for where the view is now is filled in.
 */
export function MenuBar() {
  const { output, state, act, windows } = useTrellis();
  const focused = useFocusedWindow();
  const time = useTime();
  if (!output) return null;
  const title = focused === null ? "" : windows.get(focused)?.title ?? "";
  const here = (target: Target) => sameTarget(state.framed, target);
  const saved = Object.entries(state.saved).sort(([a], [b]) => Number(a) - Number(b));

  return (
    <>
      <Reserve output={output.name} top={menuBarHeight} />
      <Screen output={output.name}>
        <Rect
          width={output.width}
          height={menuBarHeight}
          fill={{ from: "#00000059", to: "#00000000", angle: 180 }}
          interactive={false}
        />
        <Box
          width={output.width}
          height={menuBarHeight}
          flexDirection="row"
          alignItems="center"
          gap={4}
          paddingX={14}
        >
          <Text size={13.5} weight="bold" color="#ffffff" interactive={false}>Trellis</Text>
          <Text size={13.5} color="#ffffffcc" maxLines={1} width={Math.min(560, output.width * 0.35)} interactive={false}>
            {title}
          </Text>
          <Spacer />
          <Button label="‹" disabled={state.at === 0} onPress={() => act({ type: "back" })} />
          <Button label="›" disabled={state.at >= state.history.length - 1} onPress={() => act({ type: "forward" })} />
          <Button label="Desktop" filled={here({ node: "desktop" })} onPress={() => act({ type: "frame", target: { node: "desktop" } })} />
          <Button label="Everything" filled={here({ node: state.root.id })} onPress={() => act(showEverything(state))} />
          {saved.map(([slot, target]) => (
            <Button key={slot} label={slot} filled={here(target)} onPress={() => act({ type: "recall", slot: Number(slot) })} />
          ))}
          <Text size={13.5} weight="bold" color="#ffffff" interactive={false} marginLeft={10}>
            {time.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
          </Text>
        </Box>
      </Screen>
    </>
  );
}

function Button({ label, filled, disabled, onPress }: {
  label: string;
  filled?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      height={20}
      paddingX={8}
      radius={6}
      alignItems="center"
      justifyContent="center"
      fill={filled ? "#ffffff38" : hovered && !disabled ? "#ffffff1a" : "#ffffff00"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={() => {
        if (!disabled) onPress();
      }}
    >
      <Text size={13} weight="bold" color={disabled ? "#ffffff59" : "#ffffff"} interactive={false}>{label}</Text>
    </Box>
  );
}
