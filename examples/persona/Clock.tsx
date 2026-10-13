import { memo } from "react";
import { Group, Image, Rect, Text, type Color } from "proscenium";
import wave1 from "./assets/clock/wave1.png?url";
import wave2 from "./assets/clock/wave2.png?url";
import wave3 from "./assets/clock/wave3.png?url";
import wave4 from "./assets/clock/wave4.png?url";
import { fonts, spaced } from "./fonts.js";
import { Moon, moonPhase } from "./Moon.js";
import { dateWave } from "./paints.js";

const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (value: number) => String(value).padStart(2, "0");

function daytime(hour: number): string {
  if (hour >= 5 && hour < 12) return "Dawn";
  if (hour >= 12 && hour < 17) return "Noon";
  if (hour >= 17 && hour < 21) return "Dusk";
  return "Dark";
}

interface LabelProps {
  text: string;
  /** Where the text's middle, or with `end`, its right edge, goes. */
  x: number;
  y: number;
  font: string;
  size: number;
  bold?: boolean;
  spacing: number;
  color: Color;
  /** Qt's Text.Raised: the text again, a pixel lower, under it. */
  raised?: Color;
  /** Qt's Text.Outline: the text again, a pixel to each side, under it. */
  outline?: Color;
  end?: boolean;
}

/** A line of the clock's text, styled as Qt styles text. */
function Label({ text, x, y, font, size, bold, spacing, color, raised, outline, end }: LabelProps) {
  const width = 400;
  const offsets = raised ? [[0, 1]] : outline ? [[-1, 0], [1, 0], [0, -1], [0, 1]] : [];
  const line = (dx: number, dy: number, tint: Color) => (
    <Text key={`${dx},${dy}`} x={x - (end ? width : width / 2) + dx} y={y + dy} width={width}
          align={end ? "end" : "center"} markup font={font} size={size} weight={bold ? "bold" : "normal"}
          color={tint} interactive={false}>{spaced(text, spacing)}</Text>
  );
  return (
    <>
      {offsets.map(([dx, dy]) => line(dx!, dy!, (raised ?? outline)!))}
      {line(0, 0, color)}
    </>
  );
}

/** A wave rolling right to left across 500 pixels every 10 seconds, two copies side by side. */
function Roll({ src, height, rolling }: { src: string; height: number; rolling: boolean }) {
  return (
    <Group animate={rolling ? { x: [0, -500], duration: 10, ease: "linear", iterations: Infinity } : undefined}>
      <Image src={src} width={500} height={height} fit="fill" />
      <Image src={src} x={500} width={500} height={height} fit="fill" />
    </Group>
  );
}

interface ClockProps {
  /** The clock's right edge. */
  right: number;
  now: Date;
  battery: string;
  rolling: boolean;
}

/**
 * The top right corner, as the original lays out its 500 by 200 window: the
 * time over waves rolling by, the date cut out of a lighter wave, the weekday,
 * battery and part of the day, and the sun with the moon's phase over it.
 * Lengths are the original's, in its unit of 19.2 pixels.
 */
export const Clock = memo(function Clock({ right, now, battery, rolling }: ClockProps) {
  return (
    <Group x={right - 500} width={500} height={200} clip interactive={false}>
      <Group x={30} width={500} height={140} clip>
        {[wave1, wave2, wave3, wave4].map((wave) => <Roll key={wave} src={wave} height={140} rolling={rolling} />)}
      </Group>
      <Group x={30} y={-9.6} width={500} height={120} clip>
        <Text width={500} align="end" markup font={fonts.yahei} size={129.6} weight="bold" color="#ffffff"
              shaders={[{ id: "wave", shader: dateWave, time: rolling }]}>
          {spaced(`${months[now.getMonth()]}·${two(now.getDate())}`, -14.4)}
        </Text>
      </Group>
      <Label text={`${two(now.getHours())}:${two(now.getMinutes())}`} x={269.6} y={3.84} end font={fonts.yahei}
             size={115.2} bold spacing={-4.03} color="#ffffff" raised="#1300b8d1" />
      <Label text={days[now.getDay()]!} x={308} y={67.2} font={fonts.bahnschrift} size={27.84} spacing={-1.92}
             color="#ffffff" outline="#0000ff" />
      <Label text={battery} x={336.8} y={38.4} font={fonts.nerd} size={28.8} bold spacing={0} color="#fffb9f"
             raised="#5400d963" />
      <Label text={daytime(now.getHours())} x={322.4} y={96} font={fonts.yahei} size={24.96} bold spacing={-2}
             color="#00dbff" outline="#002c90" />
      <Rect x={380} y={45} width={80} height={80} radius={40} fill="#ffd200"
            shadow={{ color: "#402b00", blur: 30, x: 1, y: 1 }} />
      <Rect x={382} y={47} width={76} height={76} radius={38} fill="#ffe500" shadow={{ color: "#fff72a", blur: 32 }} />
      <Moon x={382.5} y={47} size={76} degree={moonPhase(now)} />
    </Group>
  );
});
