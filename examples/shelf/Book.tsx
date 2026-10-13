import {
  Group,
  Rect,
  rotate,
  rotateX,
  rotateY,
  spring,
  Text,
  translateZ,
  Window,
  type Rectangle,
} from "proscenium";
import { placement, variation, type Pose } from "./layout.js";

const motion = spring({ duration: 0.55, bounce: 0.16 });
const gilt = "#e3c983";
/** Cloth bindings: oxblood, navy, forest, ochre, plum, teal, walnut. */
const cloths = ["#6e1d1d", "#1b3557", "#264d33", "#7d5f19", "#432653", "#1f4a4e", "#553626"];

interface BookProps {
  id: number;
  title: string;
  /** The reading area: the window's size, and where an open book lies. */
  read: Rectangle;
  pose: Pose;
  /** The spine's thickness in the window's units. */
  thickness: number;
  open: boolean;
  /** Where a new book comes from, and how a closed one falls. */
  from: Pose;
  onPick: () => void;
  onHover: (inside: boolean) => void;
}

/**
 * A window as a book: its cover is the live window and the spine, the back
 * cover and the pages' top edge are built round it. Only faces turned toward
 * the viewer are drawn, so a book on the shelf shows its spine, its top and one
 * side: the live cover for books left of the middle, the back for the rest.
 */
export function Book({
  id,
  title,
  read,
  pose,
  thickness,
  open,
  from,
  onPick,
  onHover,
}: BookProps) {
  const { width, height } = read;
  const cloth = cloths[Math.floor(variation(id, 3) * cloths.length)]!;
  const lettering = Math.min(thickness * 0.42, height * 0.05);

  return (
    <Group
      width={width}
      height={height}
      originX={0}
      originY={0}
      transform={placement(pose)}
      initial={{ transform: placement(from) }}
      exit={{ transform: placement({ ...from, y: from.y + 160, tilt: -50 }), opacity: 0 }}
      transition={motion}
    >
      {/* The back cover, facing away behind the pages. */}
      <Rect
        width={width}
        height={height}
        fill={cloth}
        backface="hidden"
        transform={[translateZ(-thickness), rotateY(180)]}
      />
      {/* The pages' top edge, seen from above as books stand below the eye. */}
      <Rect
        y={-thickness}
        width={width}
        height={thickness}
        originY={1}
        fill={{ from: "#f1e7cc", to: "#d4c39b", angle: 90 }}
        backface="hidden"
        transform={[rotateX(90)]}
      />
      <Window
        window={id}
        width={width}
        height={height}
        tiled
        focusable={open}
        interactive={open}
        backface="hidden"
        radius={open ? 10 : 0}
        border={{ width: open ? 2 : 0, color: gilt }}
        shadow={{ color: open ? "#00000080" : "#00000000", blur: open ? 30 : 0, y: open ? 10 : 0 }}
      />
      {/* The spine, along the cover's left edge and running back. */}
      <Group
        x={-thickness}
        width={thickness}
        height={height}
        originX={1}
        backface="hidden"
        transform={[rotateY(-90)]}
      >
        <Rect
          width={thickness}
          height={height}
          fill={cloth}
          cursor="pointer"
          onPointerDown={onPick}
          onPointerEnter={() => onHover(true)}
          onPointerLeave={() => onHover(false)}
        />
        {/* A rounded spine catches the light along the middle. */}
        <Rect
          width={thickness}
          height={height}
          fill={{ from: "#ffffff22", to: "#00000066", angle: 0 }}
          interactive={false}
        />
        {[0.07, 0.1, 0.9, 0.93].map((at) => (
          <Rect key={at} y={height * at} width={thickness} height={height * 0.006} fill={gilt} />
        ))}
        <Text
          x={thickness / 2 - height * 0.36}
          y={height / 2 - lettering * 0.7}
          width={height * 0.72}
          align="center"
          font="Noto Serif, serif"
          size={lettering}
          weight={600}
          color={gilt}
          maxLines={1}
          transform={[rotate(-90)]}
        >
          {title}
        </Text>
      </Group>
    </Group>
  );
}
