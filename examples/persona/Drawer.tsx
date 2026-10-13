import { useEffect, useRef, useState } from "react";
import { Box, Group, instant, Rect, scale, Screen, Text, useOutputs, type OutputInfo } from "proscenium";
import { Blade } from "./Blade.js";
import { motion, palette } from "./config.js";
import { usePersona, type MenuKind } from "./PersonaProvider.js";

const blades: { icon: string; label: string; menu: MenuKind }[] = [
  { icon: "( •_•)", label: "Calendar", menu: "calendar" },
  { icon: "^▽^", label: "Stats", menu: "stats" },
  { icon: "╥_╥", label: "Shaders", menu: "options" },
  { icon: "•́︿•̀", label: "Power", menu: "power" },
];

/** How long the ball stays after the pointer leaves it. */
const linger = 1000;

/**
 * The drawer at the middle of an output's left edge: touching the edge rolls
 * out a ball, clicking the ball fans out a blade per menu, and pulling a blade
 * to the right opens its menu.
 */
function OutputDrawer({ output }: { output: OutputInfo }) {
  const { openMenu } = usePersona();
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [ballHovered, setBallHovered] = useState(false);
  const timer = useRef<NodeJS.Timeout>(undefined);
  const middle = output.height / 2;

  useEffect(() => () => clearTimeout(timer.current), []);

  const stay = () => {
    clearTimeout(timer.current);
    setHovered(true);
  };
  const leave = () => {
    clearTimeout(timer.current);
    if (!expanded) timer.current = setTimeout(() => setHovered(false), linger);
  };
  const fold = () => {
    setExpanded(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(false), linger);
  };

  return (
    <Screen output={output.name}>
      {expanded && <Rect width={500} height={output.height} onPointerDown={fold} />}
      <Rect y={middle - 50} width={10} height={100} onPointerEnter={stay} onPointerLeave={leave} />
      <Group x={hovered ? 10 : -150} y={middle - 40} transition={motion.ball}>
        <Box
          width={80}
          height={80}
          radius={40}
          fill={palette.background}
          border={{ width: 2, color: palette.color5 }}
          justifyContent="center"
          alignItems="center"
          transform={scale(ballHovered ? 1.05 : 1)}
          transition={{ default: instant, transform: motion.ballHover }}
          cursor="pointer"
          onPointerEnter={() => {
            setBallHovered(true);
            stay();
          }}
          onPointerLeave={() => {
            setBallHovered(false);
            leave();
          }}
          onPointerDown={() => {
            if (expanded) {
              fold();
            } else {
              setExpanded(true);
              clearTimeout(timer.current);
            }
          }}
        >
          <Text size={26} weight="bold" color={palette.foreground}>:3</Text>
        </Box>
      </Group>
      {expanded && blades.map((blade, index) => (
        <Blade
          key={blade.menu}
          index={index}
          icon={blade.icon}
          label={blade.label}
          x={95}
          y={middle - 20}
          onHover={() => clearTimeout(timer.current)}
          onPull={() => {
            openMenu(blade.menu, output.name);
            setExpanded(false);
            setHovered(false);
          }}
        />
      ))}
    </Screen>
  );
}

/** A drawer on every output. */
export function Drawer() {
  return useOutputs().map((output) => <OutputDrawer key={output.name} output={output} />);
}
