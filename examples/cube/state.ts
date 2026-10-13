/**
 * What the cube remembers, as a pure reducer: each window's face, the tiling
 * order, and how many quarter turns the cube has made. Turns are counted, not
 * wrapped, so going round from the last face to the first keeps turning the
 * same way.
 */

export const faces = 4;

export interface CubeState {
  /** Each window's face, 0 to 3. Window ids key records, so they come back as strings. */
  faceOf: Record<number, number>;
  /** Windows in tiling order. */
  order: number[];
  /** Quarter turns made, to the right positive; the face in front is this modulo 4. */
  turn: number;
  /** The compositor instance the window ids belong to. */
  instance: string | null;
}

export const initialCubeState: CubeState = { faceOf: {}, order: [], turn: 0, instance: null };

export type CubeAction =
  /** The mapped windows changed: new ones join the face in front. */
  | { type: "sync"; windows: readonly number[]; instance: string }
  /** Turn by STEP faces, to the right for positive steps. */
  | { type: "turn"; step: number }
  /** Turn the shortest way to FACE. */
  | { type: "show"; face: number }
  /** Move WINDOW to FACE. */
  | { type: "move"; window: number; face: number };

export function frontFace(state: CubeState): number {
  return ((state.turn % faces) + faces) % faces;
}

/** The quarter turns from the front to FACE the shortest way; a half turn goes right. */
export function turnsTo(state: CubeState, face: number): number {
  const ahead = (((face - frontFace(state)) % faces) + faces) % faces;
  return ahead === 3 ? -1 : ahead;
}

export function cubeReducer(state: CubeState, action: CubeAction): CubeState {
  switch (action.type) {
    case "sync": {
      // Window ids start over with the compositor: the old ones name nothing now.
      if (state.instance !== action.instance)
        state = { ...state, faceOf: {}, order: [], instance: action.instance };
      const live = new Set(action.windows);
      const front = frontFace(state);
      const faceOf: Record<number, number> = {};
      for (const id of action.windows) faceOf[id] = state.faceOf[id] ?? front;
      const kept = state.order.filter((id) => live.has(id));
      const fresh = action.windows.filter((id) => !kept.includes(id));
      const order = [...kept, ...fresh];
      // Unchanged, the state stays the same object, and nothing depending on it reruns.
      if (
        order.length === state.order.length &&
        order.every((id, index) => id === state.order[index])
      )
        return state;
      return { ...state, faceOf, order };
    }

    case "turn":
      return action.step === 0 ? state : { ...state, turn: state.turn + action.step };

    case "show": {
      const step = turnsTo(state, action.face);
      return step === 0 ? state : { ...state, turn: state.turn + step };
    }

    case "move":
      if (state.faceOf[action.window] === undefined) return state;
      return { ...state, faceOf: { ...state.faceOf, [action.window]: action.face } };
  }
}
