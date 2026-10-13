import { Card } from "./Card.js";
import { useDeck } from "./DeckProvider.js";
import { Dialog } from "./Dialog.js";
import { handPose, playPose, poseFor, sheetSize, spreadPose, type Pose } from "./layout.js";

/** Seconds between cards as they are dealt. */
const dealStep = 0.04;

/**
 * Every window as a card: the one in play fills the table, the others lie in a
 * fan along the bottom. With the switcher open they all fan out across the
 * middle, most recently played first, and the chosen one stands up. Dialogs
 * ride on their window's card, and a window gone fullscreen leaves the table.
 */
export function Cards() {
  const {
    state,
    dispatch,
    area,
    table,
    windows,
    dialogs,
    fullscreen,
    setFullscreen,
    show,
    spread,
    hover,
    setHover,
    pops,
    dealing,
  } = useDeck();
  const hoverOn = (id: number) => (hover?.window === id ? hover : null);

  const poses = new Map<number, Pose>();
  if (spread) {
    state.recent.forEach((id, index) =>
      poses.set(
        id,
        spreadPose(index, state.recent.length, area, table, id === state.selected, hoverOn(id)),
      ),
    );
  } else {
    if (state.played !== null) poses.set(state.played, playPose(table));
    state.hand.forEach((id, index) =>
      poses.set(id, handPose(index, state.hand.length, area, table, hoverOn(id))),
    );
  }

  // Paint order: the window in play under the hand, the lifted card over its neighbours.
  const lifted = spread ? state.selected : (hover?.window ?? null);
  const order = [...poses.keys()]
    .filter((id) => id !== fullscreen && windows.has(id))
    .sort((a, b) => Number(a === lifted) - Number(b === lifted));

  function pick(id: number) {
    if (spread) {
      dispatch({ type: "choose", window: id });
      dispatch({ type: "fold", play: true });
    } else {
      dispatch({ type: "play", window: id });
    }
    setHover(null);
  }

  return order.map((id) => {
    const chosen = spread && id === state.selected;
    const index = spread ? state.recent.indexOf(id) : state.hand.indexOf(id);
    const played = !spread && id === state.played;
    const info = windows.get(id);
    const size = sheetSize(info, table);
    const pose = poseFor(poses.get(id)!, size, table);
    const delay = dealing ? Math.max(0, index) * dealStep : 0;
    const riding = dialogs.get(id) ?? [];
    return (
      <Card
        key={id}
        id={id}
        index={index}
        table={table}
        size={size}
        pose={pose}
        played={played}
        shaded={riding.length > 0}
        hover={hoverOn(id)}
        title={info?.title || info?.appId || ""}
        titled={chosen || hoverOn(id) !== null}
        delay={delay}
        swaying={spread}
        popKey={chosen ? `chosen-${pops}` : hoverOn(id) ? `hover-${pops}` : null}
        onHover={(next) => {
          setHover(next);
          if (next && spread && next.window !== state.selected)
            dispatch({ type: "choose", window: id });
        }}
        onPick={() => pick(id)}
        onActivate={() => show(id)}
        onFullscreen={(value) => setFullscreen(id, value)}
      >
        {riding.map((dialog) => (
          <Dialog
            key={dialog}
            window={windows.get(dialog)!}
            card={size}
            active={played}
            onActivate={() => show(dialog)}
          />
        ))}
      </Card>
    );
  });
}
