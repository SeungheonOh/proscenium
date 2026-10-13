import { useEffect, useState } from "react";
import intro00 from "../../assets/power/intro00.png";
import intro01 from "../../assets/power/intro01.png";
import intro02 from "../../assets/power/intro02.png";
import intro03 from "../../assets/power/intro03.png";
import intro04 from "../../assets/power/intro04.png";
import intro05 from "../../assets/power/intro05.png";
import intro06 from "../../assets/power/intro06.png";
import intro07 from "../../assets/power/intro07.png";
import intro08 from "../../assets/power/intro08.png";
import intro09 from "../../assets/power/intro09.png";
import intro10 from "../../assets/power/intro10.png";
import intro11 from "../../assets/power/intro11.png";
import logoutHover from "../../assets/power/logout-hover.png";
import logout from "../../assets/power/logout.png";
import loop from "../../assets/power/loop.webm";
import opening from "../../assets/power/opening.webm";
import restartHover from "../../assets/power/restart-hover.png";
import restart from "../../assets/power/restart.png";
import shutdownHover from "../../assets/power/shutdown-hover.png";
import shutdown from "../../assets/power/shutdown.png";
import { Video } from "../Video.js";

export type PowerAction = "shutdown" | "restart" | "logout";

/** The intro's frames, played at 60 a second. */
const intro = [intro00, intro01, intro02, intro03, intro04, intro05, intro06, intro07, intro08, intro09, intro10, intro11];

const choices: { action: PowerAction; y: number; turn: number; image: string; hover: string }[] = [
  { action: "shutdown", y: -75, turn: 3, image: shutdown, hover: shutdownHover },
  { action: "restart", y: 100, turn: -5, image: restart, hover: restartHover },
  { action: "logout", y: 300, turn: -12, image: logout, hover: logoutHover },
];

function Choice({ choice, onChoose }: { choice: (typeof choices)[number]; onChoose: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className={`choice${hovered ? " hovered" : ""}`} style={{ top: choice.y, rotate: `${choice.turn}deg` }}>
      <img src={hovered ? choice.hover : choice.image} />
      <div
        className="target"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(event) => {
          event.stopPropagation();
          onChoose();
        }}
      />
    </div>
  );
}

/**
 * The power menu, Persona 3 Reload's pause screen: water splashes in, the
 * opening plays into a loop, and shutdown, restart and logout are written over it.
 */
export function Power({ onAction, onClose }: { onAction: (action: PowerAction) => void; onClose: () => void }) {
  const [stage, setStage] = useState<"intro" | "opening" | "loop">("intro");
  const [frame, setFrame] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [opened, setOpened] = useState(false);

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onClose, 300);
  };

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      if (++index < intro.length) {
        setFrame(index);
        return;
      }
      clearInterval(timer);
      setStage("opening");
    }, 1000 / 60);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && leave();
    addEventListener("keydown", escape);
    return () => {
      clearInterval(timer);
      removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <div className={`menu power${leaving ? " leaving" : ""}`} onClick={leave}>
      {intro.map((image, index) => (
        <img key={index} className="backdrop" src={image} hidden={stage !== "intro" || index !== frame} />
      ))}
      <Video src={opening} playing={stage === "opening"} hidden={stage === "intro"} onEnded={() => setOpened(true)} />
      {/* The opening's last frame stays until the loop's first is on screen. */}
      <Video src={loop} playing={opened} loop hidden={stage !== "loop"} onPlaying={() => setStage("loop")} />
      {stage !== "intro" && (
        <div className="choices" style={{ left: innerWidth / 2 - 350, top: innerHeight / 2 - 240 }}>
          {choices.map((choice) => (
            <Choice key={choice.action} choice={choice} onChoose={() => onAction(choice.action)} />
          ))}
        </div>
      )}
    </div>
  );
}
