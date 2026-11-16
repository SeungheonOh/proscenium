import { Box } from "proscenium";
import { Badge, Divider, Icon, Label, Pill, Row, type Tone } from "proscenium/ui";
import music from "../icons/music.svg";
import volume from "../icons/volume.svg";
import { Note, SectionFrame } from "./common.js";

const tones: Tone[] = ["ink", "soft", "muted", "faint", "accent", "danger"];

export default function KitSection() {
  return (
    <SectionFrame title="Labels, badges, pills, icons, dividers" grow={214}>
      <Row gap={14}>
        <Label variant="title">Title</Label>
        <Label variant="strong">Strong</Label>
        <Label variant="body">Body</Label>
        <Label variant="caption">Caption</Label>
      </Row>
      <Row gap={10}>
        {tones.map((tone) => <Label key={tone} variant="strong" tone={tone}>{tone}</Label>)}
      </Row>
      <Row gap={8}>
        <Badge />
        <Badge tone="danger" />
        <Badge tone="ink" count={3} />
        <Badge count={12} />
        <Badge tone="danger" count="99+" />
        <Badge tone="muted" count="new" />
        <Box width={1} />
        <Icon src={music} size={16} />
        <Icon src={volume} size={20} tone="accent" />
        <Icon src={music} size={24} tone="danger" />
        <Icon src={volume} size={32} tone="muted" />
      </Row>
      <Row gap={8}>
        <Pill variant="card"><Label variant="strong">Card pill</Label></Pill>
        <Pill variant="ink" height={24}><Label variant="strong" tone="inverse">Ink</Label></Pill>
        <Pill variant="accent" height={24}><Label variant="strong" tone="onAccent">Accent</Label></Pill>
      </Row>
      <Row gap={8} alignSelf="stretch">
        <Note>divider</Note>
        <Divider vertical length={14} />
        <Note>vertical</Note>
        <Divider vertical length={14} />
        <Note>between</Note>
      </Row>
      <Divider />
    </SectionFrame>
  );
}
