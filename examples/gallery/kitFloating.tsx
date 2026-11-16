import { useState } from "react";
import { Box } from "proscenium";
import { Button, ContextMenu, useTheme, Dialog, IconButton, Label, MenuButton, Row, Select, Tooltip, type MenuEntry } from "proscenium/ui";
import clipboard from "../icons/clipboard.svg";
import music from "../icons/music.svg";
import { Note, SectionFrame } from "./common.js";

export const fileMenu: MenuEntry[] = [
  { label: "New window", shortcut: "Ctrl+N", icon: music },
  { label: "Open...", shortcut: "Ctrl+O" },
  { type: "submenu", label: "Open recent", items: [{ label: "gallery.tsx" }, { label: "herdr.tsx" }, { type: "submenu", label: "Older", items: [{ label: "cube.tsx" }, { label: "deck.tsx" }] }] },
  "-",
  { label: "Word wrap", checked: true },
  { label: "Show minimap", checked: false },
  { type: "label", label: "Danger" },
  { label: "Delete", danger: true, shortcut: "Del" },
  { label: "Unavailable", disabled: true },
];

export const editMenu: MenuEntry[] = [
  { label: "Cut", shortcut: "Ctrl+X" }, { label: "Copy", shortcut: "Ctrl+C", icon: clipboard }, { label: "Paste", shortcut: "Ctrl+V" },
  "-", { type: "submenu", label: "Transform", items: [{ label: "Uppercase" }, { label: "Lowercase" }] }, { label: "Delete", danger: true },
];

const options = [{ value: "a", label: "Aurora" }, { value: "b", label: "Borealis" }, { value: "c", label: "Cirrus" }, { value: "d", label: "Dusk (unavailable)", disabled: true }];

export default function KitFloatingSection() {
  const { colors } = useTheme();
  const [choice, setChoice] = useState<string | null>("b");
  const [empty, setEmpty] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  return (
    <SectionFrame title="Kit: menus, select, tooltip, dialog" grow={500}>
      <Note>MenuButton (opens a menu with submenus), Select closed, Select empty</Note>
      <Row gap={8}>
        <MenuButton label="File" variant="outline" items={fileMenu} />
        <MenuButton label="Actions" variant="tinted" items={editMenu} />
        <Select options={options} value={choice} onChange={setChoice} width={96} />
        <Select options={options} value={empty} onChange={setEmpty} width={96} placeholder="Choose..." />
      </Row>
      <Note>Select, sizes</Note>
      <Row gap={8}>
        <Select options={options} value="a" size="small" width={100} />
        <Select options={options} value="c" size="large" width={96} />
        <Select options={options} value="a" width={100} disabled />
      </Row>
      <Note>ContextMenu: right click the card</Note>
      <ContextMenu items={fileMenu} width={360} height={70} alignItems="center" justifyContent="center" radius={12}
                   fill={colors.hover} border={{ width: 1, color: colors.border, dash: true }}>
        <Label variant="label">Right click me</Label>
      </ContextMenu>
      <Note>Tooltip (rest the pointer on an icon), Dialog (open it)</Note>
      <Row gap={8}>
        <Tooltip content="Copy to the clipboard"><IconButton icon={clipboard} variant="outline" /></Tooltip>
        <Tooltip content="Play music" side="bottom"><IconButton icon={music} /></Tooltip>
        <Button label="Open dialog" variant="filled" onPress={() => setAsking(true)} />
      </Row>
      <Box flexGrow={1} />
      <Dialog open={asking} onClose={() => setAsking(false)} title="Delete 3 files?"
              description="They move to the trash and can be restored from there for thirty days."
              actions={<><Button label="Cancel" onPress={() => setAsking(false)} /><Button label="Delete" variant="danger" onPress={() => setAsking(false)} /></>} />
    </SectionFrame>
  );
}
