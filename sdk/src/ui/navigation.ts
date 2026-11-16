// Keyboard movement through a list of items, some of which take no focus: menus,
// selects and lists share it. Pure, so it is tested on its own.

/**
 * The item KEY moves to from CURRENT (-1 for none) among items where ENABLED says which
 * take focus: Down and Up step and wrap, Home and End go to the ends. Undefined for keys
 * that move nothing; CURRENT when no other item takes focus.
 */
export function moveIndex(key: string, current: number, enabled: readonly boolean[], wrap = true): number | undefined {
  const count = enabled.length;
  const step = (from: number, by: 1 | -1): number => {
    for (let i = 1; i <= count; i++) {
      let at = from + by * i;
      if (wrap) at = ((at % count) + count) % count;
      else if (at < 0 || at >= count) return current;
      if (enabled[at]) return at;
    }
    return current;
  };
  switch (key) {
    case "Down": case "KP_Down": return step(current < 0 ? -1 : current, 1);
    case "Up": case "KP_Up": return step(current < 0 ? count : current, -1);
    case "Home": case "KP_Home": return step(-1, 1);
    case "End": case "KP_End": return step(count, -1);
    default: return undefined;
  }
}

/**
 * The item a typed prefix picks: the first enabled label after CURRENT (wrapping) that
 * starts with QUERY, ignoring case; or, when QUERY is one character repeated, cycling
 * through those starting with it. -1 for none.
 */
export function typeahead(query: string, labels: readonly string[], enabled: readonly boolean[], current: number): number {
  if (!query) return -1;
  const wanted = query.toLocaleLowerCase();
  const repeated = [...wanted].every((character) => character === wanted[0]);
  const count = labels.length;
  // A longer query keeps the current item while it still matches.
  const from = repeated ? current + 1 : Math.max(current, 0);
  for (let i = 0; i < count; i++) {
    const at = (from + i) % count;
    if (!enabled[at]) continue;
    const label = labels[at]!.toLocaleLowerCase();
    if (label.startsWith(wanted) || (repeated && label.startsWith(wanted[0]!))) return at;
  }
  return -1;
}

/** Collects typed characters into a query, starting afresh after a pause: type-ahead's buffer. */
export class TypeaheadBuffer {
  private text = "";
  private last = 0;

  constructor(private readonly pause = 600) {}

  /** The query with CHARACTER typed at NOW (milliseconds). */
  add(character: string, now = performance.now()): string {
    if (now - this.last > this.pause) this.text = "";
    this.last = now;
    this.text += character;
    return this.text;
  }
}
