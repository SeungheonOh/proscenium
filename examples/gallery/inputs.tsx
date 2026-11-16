import { useState } from "react";
import { Checkbox, Column, ProgressBar, Row, SegmentedControl, Slider, Switch, TextField } from "proscenium/ui";
import { SectionFrame } from "./common.js";

export default function InputsSection() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [level, setLevel] = useState(0.4);
  const [mode, setMode] = useState("day");
  const [text, setText] = useState("");
  return (
    <SectionFrame title="Inputs" grow={216}>
      <Row gap={16}>
        <Checkbox value={on} onValueChange={setOn} label="Checked" />
        <Checkbox value={off} onValueChange={setOff} label="Unchecked" />
        <Checkbox value disabled label="Disabled" />
      </Row>
      <Row gap={16}>
        <Switch value={on} onValueChange={setOn} />
        <Switch value={off} onValueChange={setOff} />
        <Switch value disabled />
        <Slider value={level} onValueChange={setLevel} width={160} />
      </Row>
      <SegmentedControl options={[{ value: "day", label: "Day" }, { value: "night", label: "Night" }, { value: "auto", label: "Auto" }]}
                        value={mode} onChange={setMode} />
      <Column gap={8}>
        <ProgressBar value={0.6} />
        <ProgressBar value={1} />
      </Column>
      <TextField value={text} onChangeText={setText} placeholder="Type here" width={220} />
    </SectionFrame>
  );
}
