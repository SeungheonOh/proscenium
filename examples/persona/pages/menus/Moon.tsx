// The theme's moon: a lit and a dark half, with an ellipse over them that is the terminator.

/** The moon's phase on DATE from the mean synodic month: degrees from 360 (new) down, snapping to new and full. */
export function calendarPhase(date: Date): number {
  const month = 29.53059;
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const degree = 360 - Math.floor((((days % month) + month) % month / month) * 360);
  if (degree >= 355 || degree <= 5) return 0;
  if (degree >= 175 && degree <= 185) return 180;
  return degree;
}

const lit = "#ffe700";
const dark = "#302c24";

export function Moon({ degree, size }: { degree: number; size: number }) {
  const turn = Math.cos((degree * Math.PI) / 180);
  return (
    <div className="moon" style={{ width: size, height: size }}>
      <div style={{ left: 0, background: degree < 180 ? lit : dark }} />
      <div style={{ left: "50%", background: degree < 180 ? dark : lit }} />
      <div className="terminator" style={{ transform: `scaleX(${turn})`, background: turn >= 0 ? dark : lit }} />
    </div>
  );
}
