import { useEffect, useState } from "react";
import { Moon, calendarPhase } from "./Moon.js";
import { Bubbles } from "./transitions.js";

const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** A week either side of today, climbing from the bottom left to the top right: past days shrink, coming ones grow. */
function Day({ date, offset }: { date: Date; offset: number }) {
  const today = offset === 0;
  const scale = today ? 1 : offset < 0 ? Math.max(0.4, 0.75 - -offset * 0.1) : Math.min(1.4, 0.75 + offset * 0.1);
  const size = today ? 90 : Math.max(26, 65 * scale);
  const moon = today ? 35 : Math.max(12, 25 * scale);
  const t = (offset + 3) / 6;
  const weekday = date.getDay();
  const height = size * 1.4;
  return (
    <div
      className="day"
      style={{
        left: innerWidth * 0.08 + t * innerWidth * 0.82,
        top: innerHeight * 0.72 - t * innerHeight * 0.55 - size * 0.5,
        width: size * 3.5,
        height,
        opacity: today ? 1 : Math.max(0.35, 1 - Math.abs(offset) * 0.15),
      }}
    >
      {today && (
        <>
          <div className="ring" style={{ left: -36, top: -29, width: 207, height: 207, borderWidth: 15 }} />
          <div className="ring" style={{ left: 22.5, top: 23.5, width: 90, height: 90, borderWidth: 10 }} />
        </>
      )}
      <div className="number" style={{ top: height / 2 - 59.4 }}>
        {date.getDate()}
        <div className={`weekday${weekday === 0 ? " sunday" : weekday === 6 ? " saturday" : ""}`}>
          {days[weekday]}
        </div>
      </div>
      <div className="phase" style={{ left: 150 - moon / 2, top: height / 2 + 100 - moon, width: moon * 2, height: moon * 2 }}>
        {today && <div className="halo" style={{ inset: -3 }} />}
        <Moon degree={calendarPhase(date)} size={moon * 2} />
      </div>
    </div>
  );
}

/** The calendar menu: the year and month on a blue band, and the week around today with its moons. */
export function Calendar({ now, onClose }: { now: number; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, []);
  return (
    <div className="menu" onClick={onClose}>
      {shown && <Sheet now={now} />}
      <Bubbles onPeak={() => setShown(true)} />
    </div>
  );
}

function Sheet({ now }: { now: number }) {
  const today = new Date(now);
  const width = innerWidth;
  const height = innerHeight;
  return (
    <div className="calendar">
      <div className="band" style={{ left: -0.2 * width, top: -0.1 * height, width: 2 * width, height: 0.2 * height }} />
      <div className="line" style={{ left: -0.2 * width, top: 0.99 * height, width: 3 * width }} />
      <div className="heading" style={{ top: height * 0.1 }}>
        <div className="year">{today.getFullYear()}</div>
        <div className="month">{today.toLocaleString("en", { month: "long" })}</div>
        <div className="month-number">{today.getMonth() + 1}</div>
      </div>
      {[-3, -2, -1, 0, 1, 2, 3].map((offset) => {
        const date = new Date(today);
        date.setDate(date.getDate() + offset);
        date.setHours(12, 0, 0, 0);
        return <Day key={offset} date={date} offset={offset} />;
      })}
    </div>
  );
}
