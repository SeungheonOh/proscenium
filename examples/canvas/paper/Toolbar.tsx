import { useState, type ReactNode } from "react";
import { Box, Image, Rect, rotate, Screen, Shortcut, translate } from "proscenium";
import { colors, motion } from "../../lib/theme.js";
import arrow from "./icons/arrow.svg";
import diamond from "./icons/diamond.svg";
import done from "./icons/done.svg";
import ellipse from "./icons/ellipse.svg";
import eraser from "./icons/eraser.svg";
import freedraw from "./icons/freedraw.svg";
import line from "./icons/line.svg";
import rectangle from "./icons/rectangle.svg";
import selection from "./icons/selection.svg";
import text from "./icons/text.svg";
import { usePaper } from "./Paper.js";
import { tools, type Tool } from "./wire.js";

const icons: Record<Tool, string> = { selection, freedraw, rectangle, ellipse, diamond, arrow, line, text, eraser };
/** Excalidraw's own first picks, so drawings look as they do on excalidraw.com. */
const strokes = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const backgrounds = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];
const widths = [1, 2, 4];
const height = 52;

/**
 * The paper's tools, along the bottom of the screen while the paper is out,
 * and Super+P, which takes the paper out and puts it away. Excalidraw's own
 * keys pick tools too, while the page has the keyboard. A plain card, as the
 * minimap is: glass would blur the canvas behind it again on every frame of a
 * pan.
 */
export function PaperToolbar() {
  const { output, out, setOut, tool, pickTool, style, pickStyle } = usePaper();
  return (
    <>
      <Shortcut keys="Super+P" onPress={() => setOut(!out)} />
      {output && (
        <Screen output={output.name}>
          <Box
            width={output.width}
            y={output.height - height - 22}
            flexDirection="row"
            justifyContent="center"
            interactive={false}
          >
            <Box
              height={height}
              flexDirection="row"
              alignItems="center"
              gap={2}
              paddingX={8}
              radius={14}
              fill="#ffffffe6"
              border={{ width: 1, color: "#00000018" }}
              shadow={{ color: "#0000001f", blur: 18, y: 6 }}
              opacity={out ? 1 : 0}
              transform={translate(0, out ? 0 : 16)}
              transition={motion.pop}
            >
              {tools.map((type) => (
                <Button key={type} active={tool.type === type} onPress={() => pickTool(type)}>
                  <Image src={icons[type]} width={20} height={20} interactive={false} />
                </Button>
              ))}
              <Divider />
              {strokes.map((color) => (
                <Swatch key={color} color={color} active={style.stroke === color}
                        onPress={() => pickStyle({ stroke: color })} />
              ))}
              <Divider />
              {backgrounds.map((color) => (
                <Swatch key={color} color={color} active={style.background === color}
                        onPress={() => pickStyle({ background: color })} />
              ))}
              <Divider />
              {widths.map((width) => (
                <Button key={width} active={style.width === width} onPress={() => pickStyle({ width })}>
                  <Rect width={18} height={width + 1} radius={(width + 1) / 2} fill={colors.ink} interactive={false} />
                </Button>
              ))}
              <Divider />
              <Button active={false} onPress={() => setOut(false)}>
                <Image src={done} width={20} height={20} interactive={false} />
              </Button>
            </Box>
          </Box>
        </Screen>
      )}
    </>
  );
}

function Button({ active, onPress, children }: { active: boolean; onPress: () => void; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      width={36}
      height={36}
      radius={9}
      alignItems="center"
      justifyContent="center"
      fill={active ? "#2f6fed26" : hovered ? "#0000000f" : "#00000000"}
      border={{ width: 1, color: active ? "#2f6fed59" : "#2f6fed00" }}
      cursor="pointer"
      transition={motion.pop}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={onPress}
    >
      {children}
    </Box>
  );
}

/** A color to pick; the transparent one is white, struck through. */
function Swatch({ color, active, onPress }: { color: string; active: boolean; onPress: () => void }) {
  const none = color === "transparent";
  return (
    <Box
      width={28}
      height={28}
      radius={14}
      alignItems="center"
      justifyContent="center"
      border={{ width: 2, color: active ? colors.accent : "#2f6fed00" }}
      cursor="pointer"
      transition={motion.pop}
      onPointerDown={onPress}
    >
      <Rect width={18} height={18} radius={9} fill={none ? "#ffffff" : color}
            border={{ width: 1, color: "#00000029" }} interactive={false} clip>
        {none && (
          <Rect x={-2} y={8.25} width={22} height={1.5} fill={colors.danger}
                transform={rotate(-45)} interactive={false} />
        )}
      </Rect>
    </Box>
  );
}

function Divider() {
  return <Rect width={1} height={26} marginX={4} fill="#00000017" interactive={false} />;
}
