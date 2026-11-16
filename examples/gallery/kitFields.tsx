import { useState } from "react";
import { Box } from "proscenium";
import { Button, Checkbox, Column, Glyph, Label, Pressable, Row, SegmentedControl, Slider, Switch, TextField,
  useTheme } from "proscenium/ui";
import { Note, SectionFrame } from "./common.js";

const longText = "A long line scrolls sideways in its field, keeping the caret in view as it moves to the end";
const mixed = "Café 👋🏽 你好世界 שלום مرحبا";

export default function KitFieldsSection() {
  const { colors } = useTheme();
  const [empty, setEmpty] = useState("");
  const [filled, setFilled] = useState("Hello, world");
  const [typed, setTyped] = useState("The quick brown fox jumps over the lazy dog");
  const [lines, setLines] = useState("First line\nSecond line, which is long enough to wrap onto a third");
  const [secret, setSecret] = useState("hunter2");
  const [long, setLong] = useState(longText);
  const [world, setWorld] = useState(mixed);
  const [query, setQuery] = useState("fields");
  const [checked, setChecked] = useState(false);
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0.5);
  const [mode, setMode] = useState("day");
  return (
    <SectionFrame title="Kit: TextField and keyboard focus" grow={500}>
      <Note>TextField: empty, filled, focused (autoFocus), disabled</Note>
      <Column gap={8}>
        <TextField value={empty} onChangeText={setEmpty} placeholder="Search..." width={300} />
        <TextField value={filled} onChangeText={setFilled} width={300} />
        <TextField value={typed} onChangeText={setTyped} width={300} autoFocus />
        <TextField value="Disabled field" disabled width={300} />
      </Column>
      <Note>TextField, multiline (grows to 4 lines)</Note>
      <TextField value={lines} onChangeText={setLines} multiline maxLines={4} width={300} />
      <Note>Password, read-only, a long line, mixed scripts, icons</Note>
      <Column gap={8}>
        <Row gap={8}>
          <TextField value={secret} onChangeText={setSecret} password width={146} />
          <TextField value="Read-only text" readOnly width={146} />
        </Row>
        <TextField value={long} onChangeText={setLong} width={300} />
        <TextField value={world} onChangeText={setWorld} width={300} />
        <TextField value={query} onChangeText={setQuery} width={300} placeholder="Search"
                   leading={<Glyph shape="search" size={14} color={colors.muted} />}
                   trailing={query ? (
                     <Pressable onPress={() => setQuery("")} width={18} height={18} radius={9} alignItems="center"
                                justifyContent="center" cursor="default">
                       <Glyph shape="close" size={10} color={colors.muted} />
                     </Pressable>
                   ) : undefined} />
      </Column>
      <Note>Controls for Tab focus rings (a row, in tree order)</Note>
      <Column gap={10}>
        <Row gap={14}>
          <Button label="Button" variant="outline" />
          <Checkbox value={checked} onValueChange={setChecked} label="Checkbox" />
          <Switch value={on} onValueChange={setOn} />
        </Row>
        <Slider value={level} onValueChange={setLevel} width={200} />
        <SegmentedControl options={[{ value: "day", label: "Day" }, { value: "night", label: "Night" }, { value: "auto", label: "Auto" }]}
                          value={mode} onChange={setMode} />
      </Column>
      <Box flexGrow={1} />
      <Label variant="small">Arrow keys move the slider and segments.</Label>
    </SectionFrame>
  );
}
