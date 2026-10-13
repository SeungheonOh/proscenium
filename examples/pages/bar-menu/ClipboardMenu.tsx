import { cx, stagger } from "../shared.js";
import { sendBarMenuMessage } from "./messages.js";
import { Row } from "./Row.js";

export function ClipboardMenu({ entries = [] }: { entries?: readonly string[] }) {
  return (
    <>
      <Row index={0} className="between">
        <span className="title">Clipboard</span>
        {entries.length > 0 && (
          <button className="link" onClick={() => sendBarMenuMessage({ name: "clear" })}>
            Clear
          </button>
        )}
      </Row>

      {entries.length === 0 && (
        <Row index={1} className="muted">
          Copied text appears here.
        </Row>
      )}

      <div className="list">
        {entries.map((text, index) => (
          <button
            key={text}
            className={cx("entry", "ellipsis", "rise")}
            style={stagger(index + 1)}
            title={text}
            onClick={() => sendBarMenuMessage({ name: "copy", value: text })}
          >
            {text.replace(/\s+/g, " ").slice(0, 200)}
          </button>
        ))}
      </div>
    </>
  );
}
