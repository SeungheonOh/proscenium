import { Pills } from "../components/bar/Pills.js";
import { useCube } from "./CubeProvider.js";
import { faces } from "./state.js";

const faceNumbers = Array.from({ length: faces }, (_, face) => face);

/** The bar's faces: the one in front a wide accent pill, occupied ones darker dots. */
export function FacePills() {
  const { state, front, dispatch } = useCube();
  const occupied = new Set(Object.values(state.faceOf));
  return (
    <Pills items={faceNumbers} shown={front} occupied={occupied} onPick={(face) => dispatch({ type: "show", face })} />
  );
}
