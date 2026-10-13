import { Minimap } from "../canvas/Minimap.js";
import { useMeta, useRoomDrag } from "./MetaProvider.js";

/** A minimap of the rooms on each output showing the canvas; a dragged room shows where it is. */
export function MetaMinimap() {
  const { state, outputs, focused, enteredRoom, rectOf } = useMeta();
  const roomDrag = useRoomDrag();
  const places = new Map(
    state.rooms.map((room) => {
      const rect = rectOf(room.id);
      const drag = roomDrag?.room === room.id ? roomDrag : null;
      return [room.id, drag ? { ...rect, x: drag.x, y: drag.y } : rect];
    }),
  );
  const focusedRoom = focused !== null ? (state.roomOf[focused] ?? null) : null;
  return outputs
    .filter((output) => enteredRoom(output) === null)
    .map((output) => (
      <Minimap key={output.name} output={output} places={places} focused={focusedRoom} />
    ));
}
