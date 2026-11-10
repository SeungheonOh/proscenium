/**
 * What the Settings panel is drawn on and with: plates, which are cards whose
 * corners and edges are chosen one by one so that pieces join into one card,
 * the button that lies on a plate, and the switch, radio and chevron marks.
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  Box,
  Group,
  instant,
  paintShader,
  Rect,
  rotate,
  tween,
  type BoxProps,
  type LayoutBox,
  type Shading,
} from "proscenium";
import { PopupButton, Region, type PopupButtonProps } from "../kit.js";
import { alpha, pressSeconds, standardEasing, stateSeconds, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

// ---------------------------------------------------------------------------
// Plates

/** A box filled to corners of four radii, with an edge of four widths laid over the fill. */
const platePaint = paintShader({
  uniforms: { fill: 4, edge: 4, corners: 4, sides: 4 },
  extent: { pixel: 1 },
  gate: [
    { uniform: "fill", component: 3 },
    { uniform: "edge", component: 3 },
  ],
  source: `
float plate_away(vec2 point, vec2 half_size, vec4 radii) {
  float corner = point.x < 0.0 ? (point.y < 0.0 ? radii.x : radii.w) : (point.y < 0.0 ? radii.y : radii.z);
  corner = min(corner, min(half_size.x, half_size.y));
  vec2 q = abs(point) - half_size + corner;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - corner;
}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  float outer = clamp(0.5 - plate_away(position - half_size, half_size, corners) / pixel, 0.0, 1.0);
  // Inside the edge: the box less its sides, each corner rounded less by the wider side it joins.
  vec2 low = vec2(sides.w, sides.x);
  vec2 high = size - vec2(sides.y, sides.z);
  vec4 widths = max(sides.xxzz, sides.wyyw);
  vec4 within = max(corners - widths, 0.0);
  float inner = clamp(0.5 - plate_away(position - (low + high) * 0.5, (high - low) * 0.5, within) / pixel, 0.0, 1.0);
  vec4 body = vec4(fill.rgb * fill.a, fill.a) * outer;
  vec4 line = vec4(edge.rgb * edge.a, edge.a) * max(outer - inner, 0.0);
  return line + body * (1.0 - line.a);
}
`,
});

/** Four numbers clockwise: corners from the top left, sides from the top. */
export type Four = readonly [number, number, number, number];

export interface PlateLook {
  fill: string;
  /** The edge's colour; none without one. */
  edge?: string;
  /** Corner radii; 10 all round by default. */
  corners?: number | Four;
  /** Edge widths; 1 all round by default. */
  sides?: number | Four;
  /** Whether the fill glides in, as under the pointer or a press, or changes at once. */
  glide?: "hover" | "press";
}

const four = (value: number | Four | undefined, all: number): Four =>
  typeof value === "object" ? value : [value ?? all, value ?? all, value ?? all, value ?? all];

const glides = {
  hover: tween(stateSeconds, [...standardEasing]),
  press: tween(pressSeconds, [...standardEasing]),
};

const shadings = new Map<string, readonly Shading[]>();

/** What names a look: two looks of the same key draw the same. */
function lookKey({ fill, edge, corners, sides, glide }: PlateLook): string {
  return [fill, edge, four(corners, 10), four(sides, 1), glide].join("|");
}

function plateShading(look: PlateLook): readonly Shading[] {
  const key = lookKey(look);
  let shading = shadings.get(key);
  if (!shading) {
    shading = [
      {
        id: "plate",
        shader: platePaint,
        uniforms: {
          fill: look.fill,
          edge: look.edge ?? alpha(look.fill, 0),
          corners: four(look.corners, 10),
          sides: look.edge === undefined ? [0, 0, 0, 0] : four(look.sides, 1),
        },
        transition: look.glide ? { default: instant, fill: glides[look.glide] } : instant,
      },
    ];
    shadings.set(key, shading);
  }
  return shading;
}

interface Placed {
  look: PlateLook;
  box: LayoutBox;
}

/** Takes the plates of the pieces inside a `Joined`, by the piece's id. */
const JoinContext = createContext<((id: string, placed: Placed | null) => void) | null>(null);

/**
 * Pieces that meet, drawn as one: the plates of the `Plate`s and `PlateButton`s
 * directly inside lie under all of them, so the focus ring of one piece is
 * never covered by the plate of the next.
 */
export function Joined({ children, ...box }: BoxProps) {
  const [plates, setPlates] = useState<ReadonlyMap<string, Placed>>(new Map());
  const place = useCallback((id: string, placed: Placed | null) => {
    setPlates((before) => {
      const after = new Map(before);
      if (placed) after.set(id, placed);
      else after.delete(id);
      return after;
    });
  }, []);
  return (
    <Region {...box}>
      {[...plates].map(([id, { look, box }]) => (
        <Group
          key={id}
          position="absolute"
          {...box}
          interactive={false}
          shaders={plateShading(look)}
        />
      ))}
      <JoinContext.Provider value={place}>{children}</JoinContext.Provider>
    </Region>
  );
}

export interface PlateProps extends BoxProps {
  look: PlateLook;
}

/** A Box on a plate. Inside a `Joined` the plate is drawn by it, under every piece. */
export function Plate({ look, children, ...box }: PlateProps) {
  const place = useContext(JoinContext);
  const id = useId();
  const [layout, setLayout] = useState<LayoutBox | null>(null);
  const key = lookKey(look);
  useLayoutEffect(() => {
    if (place && layout) place(id, { look, box: layout });
  }, [place, id, key, layout?.x, layout?.y, layout?.width, layout?.height]);
  useLayoutEffect(() => (place ? () => place(id, null) : undefined), [place, id]);
  return (
    <Region
      {...box}
      shaders={place ? undefined : plateShading(look)}
      onLayout={(next) => {
        if (place) setLayout(next);
        box.onLayout?.(next);
      }}
    >
      {/* Pieces inside are on their own: only what is directly in a Joined joins. */}
      <JoinContext.Provider value={null}>{children}</JoinContext.Provider>
    </Region>
  );
}

export interface PlateFills {
  rest: string;
  hover: string;
  press: string;
}

export interface PlateButtonProps extends PopupButtonProps {
  /** The plate's fill at rest, under the pointer and under a press. */
  fills: PlateFills;
  plate?: Omit<PlateLook, "fill" | "glide">;
  /** Where the plate goes in its row or column: its size and margins. */
  place?: BoxProps;
  /** Drawn over the button, given the plate's size: a mark at its edge. */
  over?: (size: { width: number; height: number }) => ReactNode;
}

const leftButton = 272;

/**
 * A kit button lying on a plate: the plate shows the fill, the button on it
 * is clear and keeps its label, focus ring and keys.
 */
export function PlateButton({ fills, plate, place, over, selected, ...button }: PlateButtonProps) {
  const theme = useWarlockTheme();
  const { motion } = useWarlock();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const lit = hovered && !button.disabled;
  const held = pressed && !button.disabled;
  // Only a fill coming in under the pointer or a press glides, and only with full motion.
  const glide = motion === "reduced" || selected || !lit ? undefined : held ? "press" : "hover";
  const clear = alpha(theme.palette.text, 0);
  return (
    <Plate
      {...place}
      look={{ ...plate, fill: held ? fills.press : lit ? fills.hover : fills.rest, glide }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => setPressed((event.button ?? leftButton) === leftButton)}
      onPointerUp={() => setPressed(false)}
      onLayout={({ width, height }) => setSize({ width, height })}
    >
      <PopupButton
        flexGrow={1}
        flexShrink={1}
        selected={selected}
        {...button}
        style={[button.style, { fill: clear, border: { width: 1, color: clear } }]}
      />
      {over && size && over(size)}
    </Plate>
  );
}

// ---------------------------------------------------------------------------
// Marks

/** A switch: a pill whose thumb sits at its end when on. It only shows; the row it is in is the control. */
export function Switch({ on, track }: { on: boolean; track: string }) {
  const theme = useWarlockTheme();
  const { palette } = theme;
  const width = theme.rem(40);
  const height = theme.rem(20);
  const thumb = theme.rem(12);
  const inset = 1 + theme.rem(3);
  return (
    <Box
      width={width}
      height={height}
      radius={height / 2}
      flexShrink={0}
      fill={on ? palette.actionFill : track}
      border={{ width: 1, color: on ? palette.actionFill : palette.borderEssential }}
    >
      <Rect
        position="absolute"
        x={on ? width - inset - thumb : inset}
        y={(height - thumb) / 2}
        width={thumb}
        height={thumb}
        radius={thumb / 2}
        fill={on ? palette.onAction : palette.textSecondary}
      />
    </Box>
  );
}

/** A radio mark in a glyph's place: a ring, with a dot in it when chosen. */
export function Radio({ chosen }: { chosen: boolean }) {
  const theme = useWarlockTheme();
  const slot = theme.rem(20);
  const ring = slot - 3;
  const dot = slot * 0.45;
  const color = chosen ? theme.palette.brandText : theme.palette.textSecondary;
  return (
    <Box width={slot} height={slot} flexShrink={0} alignItems="center" justifyContent="center">
      <Rect width={ring} height={ring} radius={ring / 2} border={{ width: 1.5, color }} />
      {chosen && (
        <Rect
          position="absolute"
          x={(slot - dot) / 2}
          y={(slot - dot) / 2}
          width={dot}
          height={dot}
          radius={dot / 2}
          fill={color}
        />
      )}
    </Box>
  );
}

/** The expander's chevron: down while collapsed, up while expanded. */
export function Chevron({ up }: { up: boolean }) {
  const theme = useWarlockTheme();
  const side = theme.rem(7);
  const stroke = 1.5;
  const color = theme.palette.textSecondary;
  return (
    <Group
      width={side}
      height={side}
      flexShrink={0}
      marginX={4}
      marginTop={up ? theme.rem(4) : 0}
      marginBottom={up ? 0 : theme.rem(4)}
      transform={[rotate(up ? -135 : 45)]}
    >
      <Rect x={0} y={side - stroke} width={side} height={stroke} fill={color} />
      <Rect x={side - stroke} y={0} width={stroke} height={side} fill={color} />
    </Group>
  );
}
