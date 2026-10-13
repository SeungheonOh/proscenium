import { Group, perspective, Rect, rotateX, useWindows } from "proscenium";
import { Book } from "./Book.js";
import { bookSize, chosen, hovered, openPose, shelfPoses, type Pose } from "./layout.js";
import { useShelf } from "./ShelfProvider.js";

/**
 * Every window as a book: the open one over the reading area, the rest on the
 * shelf in the order they were put back. With the switcher open the books stay
 * put and its choice comes off the shelf, turning its cover to the light.
 */
export function Books() {
  const { state, dispatch, area, shelf, browsing, hovered: pointed, setHovered } = useShelf();
  const windows = useWindows();
  const titles = new Map(windows.map((window) => [window.id, window.title || window.appId]));
  const read = shelf.reading;

  // While browsing, the open book goes back to its place at the end of the shelf.
  const onShelf = browsing && state.played !== null ? [...state.hand, state.played] : state.hand;
  const poses = shelfPoses(onShelf, shelf, read);
  for (const [id, pose] of poses) {
    if (browsing && id === state.selected) poses.set(id, chosen(pose));
    else if (id === pointed) poses.set(id, hovered(pose));
  }
  if (!browsing && state.played !== null) poses.set(state.played, openPose(read));

  const plankDepth = 420;

  // A spine's thickness in the window's units, fixed whatever the book's pose.
  const unitsThick = (id: number) => {
    const { height, thickness } = bookSize(id, shelf);
    return (thickness * read.height) / height;
  };

  // New books come off the shelf's end; closed ones fall from there.
  const end: Pose = {
    x: shelf.plankRight,
    y: shelf.plankY - shelf.bookHeight,
    z: 0,
    turn: 90,
    tilt: 0,
    scale: shelf.bookHeight / read.height,
  };

  // Painted from the ends of the shelf inward: each book's side recedes toward
  // the middle, behind its neighbour there. A book coming off the shelf goes
  // over the rest, and the open one over everything.
  const middle = area.x + area.width / 2;
  const open = !browsing ? state.played : null;
  const lifted = browsing ? state.selected : pointed;
  const rank = (id: number) => (id === open ? 2 : id === lifted ? 1 : 0);
  const order = [...poses.keys()].sort(
    (a, b) =>
      rank(a) - rank(b) || Math.abs(poses.get(b)!.x - middle) - Math.abs(poses.get(a)!.x - middle),
  );

  return (
    // The eye sits at the middle of the screen, looking down at the shelf.
    <Group
      x={area.x}
      y={area.y}
      width={area.width}
      height={area.height}
      transform={[perspective(2200)]}
    >
      <Group x={-area.x} y={-area.y} width={area.width} height={area.height}>
        {/* The plank's top runs back from its front edge, which the books stand on. */}
        <Rect
          x={shelf.plankLeft}
          y={shelf.plankY - plankDepth}
          width={shelf.plankRight - shelf.plankLeft}
          height={plankDepth}
          originY={1}
          fill={{ from: "#3b2617", to: "#8a5a32", angle: 90 }}
          transform={[rotateX(90)]}
        />
        <Rect
          x={shelf.plankLeft}
          y={shelf.plankY}
          width={shelf.plankRight - shelf.plankLeft}
          height={22}
          fill={{ from: "#6e4524", to: "#4a2d17", angle: 90 }}
          shadow={{ color: "#000000aa", blur: 24, y: 14 }}
        />
        {order.map((id) => (
          <Book
            key={id}
            id={id}
            title={titles.get(id) ?? ""}
            read={read}
            pose={poses.get(id)!}
            thickness={unitsThick(id)}
            open={id === open}
            from={end}
            onPick={() => {
              setHovered(null);
              if (browsing) {
                dispatch({ type: "choose", window: id });
                dispatch({ type: "fold", play: true });
              } else {
                dispatch({ type: "play", window: id });
              }
            }}
            onHover={(inside) => setHovered(inside ? id : pointed === id ? null : pointed)}
          />
        ))}
      </Group>
    </Group>
  );
}
