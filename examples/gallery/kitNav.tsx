import { useState } from "react";
import { Box } from "proscenium";
import { Divider, Label, List, ListItem, Tabs } from "proscenium/ui";
import clipboard from "../icons/clipboard.svg";
import music from "../icons/music.svg";
import volume from "../icons/volume.svg";
import brightness from "../icons/brightness.svg";
import { Note, SectionFrame } from "./common.js";

const tabs = [{ value: "general", label: "General" }, { value: "sound", label: "Sound" }, { value: "display", label: "Display" }, { value: "keys", label: "Keys" }];

export default function KitNavSection() {
  const [tab, setTab] = useState("general");
  const [seg, setSeg] = useState("sound");
  const [row, setRow] = useState("music");
  return (
    <SectionFrame title="Kit: Tabs and List" grow={500}>
      <Note>Tabs, underline</Note>
      <Tabs options={tabs} value={tab} onChange={setTab} />
      <Note>Tabs, segmented</Note>
      <Tabs options={tabs} value={seg} onChange={setSeg} variant="segmented" />
      <Divider />
      <Note>List: selected row, description, detail, icons, a disabled row</Note>
      <List>
        <ListItem icon={music} label="Music" description="Albums and playlists" detail="128" selected={row === "music"} onPress={() => setRow("music")} />
        <ListItem icon={volume} label="Volume" detail="Ctrl+V" selected={row === "volume"} onPress={() => setRow("volume")} />
        <ListItem icon={brightness} label="Brightness" description="Display" selected={row === "bright"} onPress={() => setRow("bright")} />
        <ListItem icon={clipboard} label="Clipboard history" detail="12" selected={row === "clip"} onPress={() => setRow("clip")} />
        <ListItem label="Disabled row" disabled />
      </List>
      <Box flexGrow={1} />
      <Label variant="small">Tab reaches the chosen tab; arrows move through the List.</Label>
    </SectionFrame>
  );
}
