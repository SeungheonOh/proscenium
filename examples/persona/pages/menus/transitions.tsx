// The three entrances the original's menus open with. Each starts 80 ms after
// the menu opens, as the original's transition windows do, and calls `onPeak`
// once the screen is covered and the menu may show beneath.

import { useEffect, useRef, useState } from "react";
import { ease } from "../easing.js";

const palette = ["#0d1a3a", "#1a6aff", "#7dd4fc"];
const start = 80;

/** Plays KEYFRAMES on the element REF holds, once it mounts. */
function useAnimation(ref: React.RefObject<HTMLElement | null>, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  useEffect(() => {
    const animation = ref.current!.animate(keyframes, { fill: "both", ...options });
    return () => animation.cancel();
  }, []);
}

function useTimer(callback: () => void, delay: number) {
  useEffect(() => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  }, []);
}

/** The stats menu's: three panels wipe across from the left and back, the darkest on top. */
export function Wipe() {
  return (
    <div className="transition">
      {palette.map((color, index) => <WipePanel key={color} color={color} index={index} />)}
    </div>
  );
}

function WipePanel({ color, index }: { color: string; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimation(ref, [
    { transform: "scaleX(0)", easing: ease.inOutQuart },
    { transform: "scaleX(1)", offset: 350 / 900 },
    { transform: "scaleX(1)", offset: 550 / 900, easing: ease.inOutQuart },
    { transform: "scaleX(0)" },
  ], { duration: 900, delay: start + index * 100 });
  return <div ref={ref} className="panel" style={{ background: color, zIndex: 3 - index }} />;
}

/** The options menu's: black sweeps in under three slanted bands that slide in and fade. */
export function Shards({ onPeak }: { onPeak: () => void }) {
  const black = useRef<HTMLDivElement>(null);
  useAnimation(black, [
    { transform: "translateX(-100%)", easing: ease.outExpo },
    { transform: "translateX(0)", offset: 350 / 950 },
    { transform: "translateX(0)", offset: 750 / 950, easing: ease.inExpo },
    { transform: "translateX(-100%)" },
  ], { duration: 950, delay: start });
  useTimer(onPeak, start + 160 + 350);
  return (
    <div className="transition">
      <div ref={black} className="panel" style={{ background: "#000" }} />
      <div className="shards">
        {palette.map((color, index) => <Shard key={color} color={color} index={index} />)}
      </div>
    </div>
  );
}

function Shard({ color, index }: { color: string; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimation(ref, [
    { transform: "translateX(-100%) matrix(1, 0, -0.15, 1, 0, 0)", opacity: 1, easing: ease.outExpo },
    { transform: "translateX(0) matrix(1, 0, -0.15, 1, 0, 0)", opacity: 1, offset: 350 / 750 },
    { transform: "translateX(0) matrix(1, 0, -0.15, 1, 0, 0)", opacity: 1, offset: 550 / 750, easing: ease.inQuad },
    { transform: "translateX(0) matrix(1, 0, -0.15, 1, 0, 0)", opacity: 0 },
  ], { duration: 750, delay: start + index * 80 });
  return <div ref={ref} className="shard" style={{ background: color }} />;
}

interface Bubble {
  x: number;
  y: number;
  size: number;
  rise: number;
  delay: number;
  drift: number;
  color: string;
}

/** Squares over the whole screen, columns from the right first, that round into bubbles and float away. */
function bubbles(): Bubble[] {
  const width = innerWidth;
  const height = innerHeight;
  const cell = Math.max(70, Math.round(Math.min(width, height) / 9));
  const columns = Math.max(6, Math.ceil(width / cell));
  const rows = Math.max(5, Math.ceil(height / cell));
  const across = width / columns;
  const down = height / rows;
  const list: Bubble[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const size = Math.max(across, down) * (1.25 + Math.random() * 0.2);
      list.push({
        x: column * across + across / 2 + (Math.random() - 0.5) * across * 0.3 - size / 2,
        y: row * down + down / 2 + (Math.random() - 0.5) * down * 0.3 - size / 2,
        size,
        rise: 400 + Math.random() * 250,
        delay: (columns - 1 - column) * 10 + Math.random(),
        drift: (Math.random() - 0.5) * across * 1.1,
        color: palette[Math.floor(Math.random() * palette.length)]!,
      });
    }
  }
  return list;
}

/** The calendar's: the wipe's panels sweep in, then break up into bubbles that rise away. */
export function Bubbles({ onPeak }: { onPeak: () => void }) {
  const [rising, setRising] = useState<Bubble[] | null>(null);
  useTimer(() => {
    setRising(bubbles());
    onPeak();
  }, start + 200 + 350 + 100);
  return (
    <div className="transition">
      {rising
        ? rising.map((bubble, index) => <Rising key={index} bubble={bubble} />)
        : palette.map((color, index) => <SweepPanel key={color} color={color} index={index} />)}
    </div>
  );
}

function SweepPanel({ color, index }: { color: string; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimation(ref, [
    { transform: "scaleX(0)", easing: ease.inOutQuart },
    { transform: "scaleX(1)" },
  ], { duration: 350, delay: start + index * 100 });
  return <div ref={ref} className="panel" style={{ background: color, zIndex: 3 - index }} />;
}

function Rising({ bubble }: { bubble: Bubble }) {
  const lift = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const shine = useRef<HTMLDivElement>(null);
  const { delay } = bubble;
  const { rise, size } = bubble;
  useAnimation(lift, [
    { transform: "translateY(0)", easing: ease.inCubic },
    { transform: `translateY(${-size * 2 - bubble.y}px)` },
  ], { duration: rise, delay });
  useEffect(() => {
    const animations = [
      body.current!.animate([
        { borderRadius: "0px", easing: ease.outQuad }, { borderRadius: `${size / 2}px` },
      ], { duration: 300, delay, fill: "both" }),
      body.current!.animate([
        { backgroundColor: palette[0], easing: ease.outQuad }, { backgroundColor: bubble.color },
      ], { duration: 340, delay, fill: "both" }),
      body.current!.animate([
        { transform: "translateX(0)", easing: ease.inOutSine }, { transform: `translateX(${bubble.drift}px)` },
      ], { duration: rise, delay, fill: "both" }),
      body.current!.animate([
        { opacity: 1 }, { opacity: 1, offset: 0.5, easing: ease.inQuad }, { opacity: 0 },
      ], { duration: rise, delay, fill: "both" }),
      // The gloss shows as the square rounds.
      shine.current!.animate([
        { opacity: 0, easing: ease.outQuad }, { opacity: 0.25 },
      ], { duration: 300, delay, fill: "both" }),
    ];
    return () => animations.forEach((animation) => animation.cancel());
  }, []);
  return (
    <div ref={lift} className="bubble" style={{ left: bubble.x, top: bubble.y, width: size, height: size }}>
      <div ref={body} className="body">
        <div ref={shine} className="shine" />
      </div>
    </div>
  );
}
