import { createContext, useContext, useState, type ReactNode } from "react";
import { Box, Image, Rect, rotate, Screen, Shortcut, translate } from "proscenium";
import { Icon } from "proscenium/ui";
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

/** How the toolbar is drawn; a world on a dark desktop gives its own. */
export interface ToolbarLook {
  card: string;
  edge: string;
  shadow: string;
  /** Glyphs and the width samples; the icons keep their own colours without `icons`. */
  ink: string;
  icons?: string;
  hover: string;
  active: string;
  activeEdge: string;
  /** The ring round the colour picked. */
  ring: string;
  divider: string;
}

const lightLook: ToolbarLook = {
  card: "#ffffffe6",
  edge: "#00000018",
  shadow: "#0000001f",
  ink: String(colors.ink),
  hover: "#0000000f",
  active: "#2f6fed26",
  activeEdge: "#2f6fed59",
  ring: String(colors.accent),
  divider: "#00000017",
};

const LookContext = createContext<ToolbarLook>(lightLook);

/**
 * The paper's tools, along the bottom of the screen while the paper is out,
 * and Super+P, which takes the paper out and puts it away. Excalidraw's own
 * keys pick tools too, while the page has the keyboard. A plain card, as the
 * minimap is: glass would blur the canvas behind it again on every frame of a
 * pan.
 */
export function PaperToolbar({ keys = "Super+P", strokeColors = strokes, look = lightLook }: {
  /** The shortcut that takes the paper out and puts it away. */
  keys?: string;
  /** The stroke colours offered, for a world whose canvas is dark. */
  strokeColors?: readonly string[];
  look?: ToolbarLook;
} = {}) {
  const { output, out, setOut, tool, pickTool, style, pickStyle } = usePaper();
  return (
    <LookContext.Provider value={look}>
      <Shortcut keys={keys} onPress={() => setOut(!out)} />
      {output && (
        <Screen output={output.name}>
          <Box
            width={output.width}
            y={output.height - height - 22}
            flexDirection="row"
            justifyContent="center"
          >
            <Box
              height={height}
              flexDirection="row"
              alignItems="center"
              gap={2}
              paddingX={8}
              radius={14}
              fill={look.card}
              border={{ width: 1, color: look.edge }}
              shadow={{ color: look.shadow, blur: 18, y: 6 }}
              opacity={out ? 1 : 0}
              transform={translate(0, out ? 0 : 16)}
              transition={motion.pop}
            >
              {tools.map((type) => (
                <Button key={type} active={tool.type === type} onPress={() => pickTool(type)}>
                  <Glyph src={icons[type]} />
                </Button>
              ))}
              <Divider />
              {strokeColors.map((color) => (
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
                  <Rect width={18} height={width + 1} radius={(width + 1) / 2} fill={look.ink} />
                </Button>
              ))}
              <Divider />
              <Button active={false} onPress={() => setOut(false)}>
                <Glyph src={done} />
              </Button>
            </Box>
          </Box>
        </Screen>
      )}
    </LookContext.Provider>
  );
}

/** A tool's icon, in the look's colour where it has one. */
function Glyph({ src }: { src: string }) {
  const look = useContext(LookContext);
  if (!look.icons) return <Image src={src} width={20} height={20} />;
  return <Icon src={src} size={20} tint={look.icons} />;
}

function Button({ active, onPress, children }: { active: boolean; onPress: () => void; children: ReactNode }) {
  const look = useContext(LookContext);
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      width={36}
      height={36}
      radius={9}
      alignItems="center"
      justifyContent="center"
      fill={active ? look.active : hovered ? look.hover : clear(look.hover)}
      border={{ width: 1, color: active ? look.activeEdge : clear(look.activeEdge) }}
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
  const look = useContext(LookContext);
  const none = color === "transparent";
  return (
    <Box
      width={28}
      height={28}
      radius={14}
      alignItems="center"
      justifyContent="center"
      border={{ width: 2, color: active ? look.ring : clear(look.ring) }}
      cursor="pointer"
      transition={motion.pop}
      onPointerDown={onPress}
    >
      <Rect width={18} height={18} radius={9} fill={none ? "#ffffff" : color}
            border={{ width: 1, color: "#00000029" }} clip>
        {none && (
          <Rect x={-2} y={8.25} width={22} height={1.5} fill={colors.danger}
                transform={rotate(-45)} />
        )}
      </Rect>
    </Box>
  );
}

function Divider() {
  const look = useContext(LookContext);
  return <Rect width={1} height={26} marginX={4} fill={look.divider} />;
}

/** COLOR, a "#rrggbb" or "#rrggbbaa", with no alpha: what a fill fades out to without darkening. */
function clear(color: string): string {
  return color.slice(0, 7) + "00";
}
