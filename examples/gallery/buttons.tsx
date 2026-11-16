import { Box } from "proscenium";
import { Button, IconButton, Row } from "proscenium/ui";
import brightness from "../icons/brightness.svg";
import clipboard from "../icons/clipboard.svg";
import music from "../icons/music.svg";
import volume from "../icons/volume.svg";
import { Note, SectionFrame } from "./common.js";

export default function ButtonsSection() {
  return (
    <SectionFrame title="Buttons" grow={210}>
      <Row gap={8}>
        <Button label="Plain" />
        <Button label="Tinted" variant="tinted" />
        <Button label="Filled" variant="filled" />
        <Button label="Selected" selected />
        <Button label="Disabled" variant="filled" disabled />
      </Row>
      <Row gap={8}>
        <Button label="Small" size="small" />
        <Button label="Tinted" size="small" variant="tinted" />
        <Button label="Filled" size="small" variant="filled" />
        <Button label="Selected" size="small" variant="tinted" selected />
        <Button label="Disabled" size="small" disabled />
      </Row>
      <Row gap={8}>
        <Button label="With icon" icon={music} variant="tinted" />
        <Button label="Filled" icon={volume} variant="filled" />
        <Button icon={clipboard} />
      </Row>
      <Row gap={6}>
        <IconButton icon={brightness} />
        <IconButton icon={music} selected />
        <IconButton icon={volume} />
        <IconButton icon={clipboard} disabled />
        <IconButton icon={brightness} size={28} iconSize={16} />
        <Box flexGrow={1} />
        <Note>hover and press me</Note>
      </Row>
    </SectionFrame>
  );
}
