import { useState } from "react";
import background from "../../assets/options/background.webm";
import member1 from "../../assets/options/member1.png";
import member2 from "../../assets/options/member2.png";
import member3 from "../../assets/options/member3.png";
import portrait1 from "../../assets/options/portrait1.jpeg";
import portrait2 from "../../assets/options/portrait2.jpeg";
import portrait3 from "../../assets/options/portrait3.jpeg";
import { Video } from "../Video.js";
import { Shards } from "./transitions.js";

export type ScreenFilter = "bluelight" | "greyscale" | "inversion";

const filters: { filter: ScreenFilter; role: string; label: string; member: string; portrait: string;
                 upper: string; lower: string }[] = [
  { filter: "bluelight", role: "LEADER", label: "Bluelight", member: member1, portrait: portrait1,
    upper: "Filter to reduce Bluelight", lower: "blue light filter" },
  { filter: "greyscale", role: "PARTY", label: "Greyscale", member: member2, portrait: portrait2,
    upper: "Black and white only", lower: "grey scale filter" },
  { filter: "inversion", role: "PARTY", label: "Inversion", member: member3, portrait: portrait3,
    upper: "Invert all the colors cuz why not", lower: "inversion filter" },
];

interface OptionsProps {
  filter: ScreenFilter | null;
  onFilter: (filter: ScreenFilter | null) => void;
  onClose: () => void;
}

/** A click that does not also close the menu. */
const own = (action: () => void) => (event: React.MouseEvent) => {
  event.stopPropagation();
  action();
};

/**
 * The shaders menu, Persona's party screen: a member per screen shader slides
 * in; choosing one swings in a panel with its portrait, where the shader is
 * switched on or off.
 */
export function Options({ filter, onFilter, onClose }: OptionsProps) {
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tab, setTab] = useState(0);
  const chosen = filters[tab]!;
  const on = filter === chosen.filter;

  return (
    <div className="menu options" onClick={onClose}>
      <Video src={background} playing={shown} loop hidden={!shown} />
      {shown && (
        <>
          <div className="party">
            {filters.map((member, index) => (
              <div
                key={member.filter}
                className={`member${index === active ? " active" : ""}`}
                onMouseEnter={() => !revealed && setActive(index)}
                onClick={own(() => {
                  setActive(index);
                  setTab(index);
                  setRevealed(true);
                })}
              >
                <div className="accent" />
                <div className="bar">
                  <div className="light"><div className="fold" /></div>
                  <div className="shade" />
                  <img src={member.member} />
                  <span className="role">{member.role}</span>
                  <span className="label">{member.label}</span>
                </div>
              </div>
            ))}
          </div>
          <div className={`reveal${revealed ? " revealed" : ""}`}>
            <div className="dim" />
            <div className="portrait"><img src={chosen.portrait} /></div>
            <div className="sway">
              <div className="stretch">
                <div className="sheet">
                  <div className="stripe" />
                  <div className="tabs">
                    {filters.map((member, index) => (
                      <button key={member.filter} className={index === tab ? "active" : ""} onClick={own(() => setTab(index))}>
                        {member.label}
                      </button>
                    ))}
                  </div>
                  <div className="upper">{chosen.upper}</div>
                  <button className={`toggle${on ? " on" : ""}`} onClick={own(() => onFilter(on ? null : chosen.filter))}>
                    <span>{chosen.lower}</span>
                    <span className="state">{on ? "● ON" : "○ OFF"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      <Shards onPeak={() => setShown(true)} />
    </div>
  );
}
