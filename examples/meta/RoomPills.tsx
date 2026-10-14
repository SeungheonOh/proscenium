import { Box, useCamera, type OutputInfo } from "proscenium";
import { RollingText } from "../components/bar/BarText.js";
import { Pills } from "../components/bar/Pills.js";
import { useMeta } from "./MetaProvider.js";

/** "Canvas · 34%" on the canvas, else the room's number and kind; clicking it leaves to the canvas. */
function Place({ output, room }: { output: OutputInfo; room: number | null }) {
  const camera = useCamera(output.name);
  const { state, enter, worldOf } = useMeta();
  const number =
    room === null ? 0 : state.rooms.findIndex((candidate) => candidate.id === room) + 1;
  const zoom = Math.round((camera?.zoom ?? 1) * 100);
  return (
    <Box cursor="pointer" onPointerDown={() => enter(null, output)}>
      <RollingText identity={number}>
        {room === null ? `Canvas · ${zoom}%` : `Room ${number} · ${worldOf(room).kind}`}
      </RollingText>
    </Box>
  );
}

/**
 * The bar's rooms, in the order they were made: the one this output shows a wide
 * accent pill, occupied ones darker. Clicking a pill enters its room.
 */
export function RoomPills({ output }: { output: OutputInfo }) {
  const { state, present, enteredRoom, enter } = useMeta();
  const shown = enteredRoom(output);
  const occupied = new Set([...present].map((id) => state.roomOf[id]));

  return (
    <Box flexDirection="row" alignItems="center" gap={8}>
      <Pills
        items={state.rooms.map(({ id }) => id)}
        shown={shown}
        occupied={occupied}
        onPick={(id) => enter(id, output)}
      />
      <Place output={output} room={shown} />
    </Box>
  );
}
