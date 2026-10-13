import { useEffect, useState } from "react";
import background from "../../assets/stats/background.webm";
import { Video } from "../Video.js";
import { Wipe } from "./transitions.js";

export interface StatsData {
  system: { os: string; cpu: number; memory: string; disk: string; users: string } | null;
  networks: { ssid: string; strength: number; active: boolean }[];
  bluetooth: { available: boolean; enabled: boolean; devices: { name: string; connected: boolean; paired: boolean }[] } | null;
}

const cards = [
  { badge: "I", title: "Stats", subtitle: "System Stats and Info", rank: 3, heading: "System Stats" },
  { badge: "II", title: "Network", subtitle: "Wifi Networks and connections", rank: 4, heading: "Wifi networks" },
  { badge: "III", title: "Bluetooth", subtitle: "Bluetooth Devices", rank: 5, heading: "Bluetooth devices" },
];

function rows(card: number, data: StatsData): { title: string; status: string }[] {
  if (card === 0) {
    const system = data.system;
    return [
      { title: "OS", status: system?.os ?? "" },
      { title: "CPU", status: `${Math.round((system?.cpu ?? 0) * 100)}%` },
      { title: "RAM", status: system?.memory ?? "" },
      { title: "DISK", status: system?.disk ?? "" },
      { title: "Users", status: system?.users ?? "" },
    ];
  }
  if (card === 1) {
    return data.networks.map((network) => ({
      title: network.ssid, status: network.active ? "Connected" : `${network.strength}%`,
    }));
  }
  const bluetooth = data.bluetooth;
  if (!bluetooth?.devices.length) {
    return [{
      title: bluetooth?.available ? "Bluetooth Off" : "No Adapter",
      status: bluetooth?.enabled ? "No Devices" : "Disabled",
    }];
  }
  return bluetooth.devices.map((device) => ({
    title: device.name, status: device.connected ? "Connected" : device.paired ? "Paired" : "Found",
  }));
}

function Card({ index, active, onActivate }: { index: number; active: boolean; onActivate: () => void }) {
  const card = cards[index]!;
  return (
    <div
      className={`card${active ? " active" : ""}`}
      onMouseEnter={onActivate}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      <div className="face" />
      <div className="edge" />
      <div className="badge"><span>{card.badge}</span></div>
      <div className="title">{card.title}</div>
      <div className="rank"><span>RANK</span><span className="value">{card.rank}</span></div>
      <div className="subtitle">{card.subtitle}</div>
    </div>
  );
}

/**
 * The stats menu, Persona's social stats screen: a looping video behind a
 * list of three cards and the active one's details.
 */
export function Stats({ data, onClose }: { data: StatsData; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 730);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <div className="menu stats" onClick={onClose}>
      <Video src={background} playing={shown} loop hidden={!shown} />
      {shown && (
        <>
          <div className="list" style={{ left: innerWidth * 0.028, top: innerHeight * 0.09 }}>
            <div className="heading">LIST</div>
            {cards.map((card, index) => (
              <Card key={card.title} index={index} active={index === active} onActivate={() => setActive(index)} />
            ))}
          </div>
          <div
            className="detail"
            style={{ right: innerWidth * 0.045, top: innerHeight * 0.095,
                     width: Math.min(innerWidth * 0.39, 620), height: innerHeight * 0.74 }}
          >
            <div className="header">
              <span className="index">{`0${active + 1}`}</span>
              <span>{cards[active]!.heading}</span>
            </div>
            <div className="rows">
              {rows(active, data).map((row, index) => (
                <div key={index} className="row">
                  <span>{row.title}</span>
                  <span className="status">{row.status}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <Wipe />
    </div>
  );
}
