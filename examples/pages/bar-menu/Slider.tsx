import type { CSSProperties } from "react";

interface SliderProps {
  value: number;
  min?: number;
  onChange: (value: number) => void;
}

/** A 0–100 range input whose track fills up to the thumb. */
export function Slider({ value, min = 0, onChange }: SliderProps) {
  const fill = `${((value - min) / (100 - min)) * 100}%`;
  return (
    <input
      type="range"
      min={min}
      max={100}
      value={value}
      style={{ "--fill": fill } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}
