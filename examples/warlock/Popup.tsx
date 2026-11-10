/** The one popup Warlock shows at a time: which panel it is, on which output. */

import { Screen } from "proscenium";
import { ApplicationsPanel } from "./panels/Applications.js";
import { FilesPanel } from "./panels/Files.js";
import { JumpPanel } from "./panels/Jump.js";
import { NotificationsPanel } from "./panels/Notifications.js";
import { PickerPanel } from "./panels/Picker.js";
import { SettingsPanel } from "./panels/Settings.js";
import { SnapPanel } from "./panels/Snap.js";
import { SwitcherPanel } from "./panels/Switcher.js";
import { SystemPanel } from "./panels/System.js";
import { TaskViewPanel } from "./panels/TaskView.js";
import { WindowMenuPanel } from "./panels/WindowMenu.js";
import { useWarlock, type Popup } from "./WarlockProvider.js";

function panel(popup: Popup) {
  switch (popup.mode) {
    case "applications":
      return <ApplicationsPanel />;
    case "overview":
      return <TaskViewPanel />;
    case "switcher":
      return <SwitcherPanel />;
    case "snap":
      return <SnapPanel window={popup.window} />;
    case "menu":
      return <WindowMenuPanel window={popup.window} />;
    case "picker":
      return <PickerPanel group={popup.group} />;
    case "jump":
      return <JumpPanel entry={popup.entry} />;
    case "notifications":
      return <NotificationsPanel />;
    case "system":
      return <SystemPanel />;
    case "settings":
      return <SettingsPanel />;
    case "files":
      return <FilesPanel />;
  }
}

/** The open popup, over everything on its output. A popup opened again starts afresh. */
export function PopupLayer() {
  const { popup } = useWarlock();
  if (!popup) return null;
  return (
    <Screen key={`${popup.mode}-${popup.serial}`} output={popup.output}>
      {panel(popup)}
    </Screen>
  );
}
