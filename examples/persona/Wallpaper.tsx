import { existsSync } from "node:fs";
import { memo, useState } from "react";
import { Group, Image, instant, Rect, scale, type OutputInfo, type UniformValue } from "proscenium";
import fullBackground from "./assets/wallpaper/bg.png?url";
import smallBackground from "./assets/wallpaper/bg-2560.png?url";
import fullBars from "./assets/wallpaper/bars.png?url";
import smallBars from "./assets/wallpaper/bars-2560.png?url";
import fullForeground from "./assets/wallpaper/fg.png?url";
import smallForeground from "./assets/wallpaper/fg-2560.png?url";
import { spectrum, spectrumBars } from "./paints.js";
import { Rain } from "./Rain.js";

/** The art's size; every layer covers the output as this does. */
const art = { width: 3840, height: 2194 };
/**
 * Copies of the art 2560 wide, which outputs up to that wide draw from: a
 * texture near the size it is shown is several times cheaper to draw.
 */
const small = existsSync(smallBackground) && existsSync(smallBars) && existsSync(smallForeground);
/** How far down the carriage's windows show the world outside, in the art. */
const windowsBottom = 1192 / art.height;
/**
 * The passing train in its art: two posts and the cars below them, as boxes
 * of x, y, width and height. The rest of it is clear, and drawing it would
 * cost as much as drawing the parts.
 */
const trainParts = [[596, 0, 116, 904], [2710, 0, 114, 904], [0, 904, 3840, 280]];
/** How tall the spectrum is, as the original's visualizer. */
const spectrumHeight = 555;
/**
 * DepthFlow's parallax, as the original sets it up, moves what lies behind the
 * windows by 3% of half the height toward the pointer, and the carriage and
 * the two of them 8% less: two layers make the same picture.
 */
const reach = 0.015;
const nearer = 0.92;
/** Enough to keep the layers' edges off screen as they shift. */
const margin = scale(1 + 2.5 * reach);

interface WallpaperProps {
  output: OutputInfo;
  /** False while something covers it: nothing moves then. */
  moving: boolean;
  /** Bar heights in 0..1 for the hills behind the windows, or null for none. */
  bars: number[] | null;
}

const Spectrum = memo(function Spectrum({ width, values }: { width: number; values: number[] }) {
  const uniforms: Record<string, UniformValue> = { count: Math.min(values.length, spectrumBars) };
  for (let index = 0; index < spectrumBars; index += 4) {
    const [a = 0, b = 0, c = 0, d = 0] = values.slice(index, index + 4);
    uniforms[`bars${index / 4}`] = [a, b, c, d];
  }
  return (
    <Rect width={width} height={spectrumHeight} interactive={false}
          shaders={[{ id: "spectrum", shader: spectrum, uniforms, transition: instant }]} />
  );
});

interface TrainProps {
  src: string;
  left: number;
  top: number;
  scaling: number;
  moving: boolean;
}

/**
 * The passing train: each of its parts, twice side by side, seen through a box
 * of its own size and moving on its own, so a frame repaints only where the
 * parts were and are.
 */
function Train({ src, left, top, scaling, moving }: TrainProps) {
  const span = art.width * scaling;
  return [0, 1].flatMap((copy) => trainParts.map(([x, y, width, height]) => (
    <Group key={`${copy} ${x} ${y}`}
           animate={moving ? { x: [0, -span], duration: 1, ease: "linear", iterations: Infinity, key: span } : undefined}>
      <Group x={left + copy * span + x! * scaling} y={top + y! * scaling} width={width! * scaling}
             height={height! * scaling} clip>
        <Image src={src} x={-x! * scaling} y={-y! * scaling} width={span} height={art.height * scaling} />
      </Group>
    </Group>
  )));
}

/**
 * The original's wallpaper engine, drawn by the compositor: the sea and city,
 * rain, the train passing outside a width a second, the music as hills, and
 * the carriage, all shifting with the pointer over the desktop. What moves
 * stays within the windows, so a frame repaints only them.
 */
export function Wallpaper({ output, moving, bars: values }: WallpaperProps) {
  const { width, height } = output;
  const [pointer, setPointer] = useState([0, 0]);
  const scaling = Math.max(width / art.width, height / art.height);
  const shown = { width: art.width * scaling, height: art.height * scaling };
  const left = (width - shown.width) / 2;
  const top = (height - shown.height) / 2;
  const windows = top + shown.height * windowsBottom;
  const sharp = !small || width * output.scale > 2560;
  const shift = (amount: number) => ({
    x: pointer[0]! * reach * height * amount,
    y: -pointer[1]! * reach * height * amount,
  });
  const layer = { width, height, transform: margin, transition: instant };

  return (
    <>
      <Group {...layer} {...shift(1)}>
        <Image src={sharp ? fullBackground : smallBackground} width={width} height={height} fit="cover" />
        <Group width={width} height={windows} clip>
          <Rain width={width} height={height} visible={windows} falling={moving} />
          <Train src={sharp ? fullBars : smallBars} left={left} top={top} scaling={scaling} moving={moving} />
        </Group>
        {values && <Spectrum width={width} values={values} />}
      </Group>
      <Group {...layer} {...shift(nearer)}>
        <Image src={sharp ? fullForeground : smallForeground} width={width} height={height} fit="cover" />
      </Group>
      <Rect
        width={width}
        height={height}
        onPointerMove={(event) => setPointer([(event.screenX / width - 0.5) * 2, (event.screenY / height - 0.5) * 2])}
      />
    </>
  );
}
