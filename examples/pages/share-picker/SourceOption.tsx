import { cx, stagger } from "../shared.js";

interface SourceOptionProps {
  /** Place in the picker's staggered entrance. */
  index: number;
  name: string;
  detail: string;
  thumbnail: string;
  selected: boolean;
  onSelect: () => void;
  onChoose: () => void;
}

/** A screen or window to share: a click selects it, a double click shares it at once. */
export function SourceOption({
  index,
  name,
  detail,
  thumbnail,
  selected,
  onSelect,
  onChoose,
}: SourceOptionProps) {
  return (
    <button
      className={cx("option", "rise", selected && "on")}
      style={stagger(index)}
      onClick={onSelect}
      onDoubleClick={onChoose}
    >
      <span className="thumb">{thumbnail}</span>
      <span className="ellipsis">
        <span className="name ellipsis">{name}</span>
        <span className="detail ellipsis">{detail}</span>
      </span>
    </button>
  );
}
