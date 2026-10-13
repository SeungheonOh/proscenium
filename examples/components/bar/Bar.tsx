/**
 * The top bar, drawn by the world itself: a frosted card with the world's own
 * controls on the left, the focused window's title in the middle, and status
 * items and the clock on the right. Items open menus, all served by one React
 * DOM page that stays loaded while hidden. The bar reserves its strip of every
 * output, so window layouts leave it free.
 *
 * Motion is all one-shot springs, and every source is event-driven, so an idle
 * bar wakes the director once a minute, for its clock.
 */

import { useRef, useState, type ComponentType } from "react";
import { Reserve, useOutputs, type OutputInfo } from "proscenium";
import { BarMenu, type OpenMenu } from "./BarMenu.js";
import { BarStrip } from "./BarStrip.js";
import { barLayout } from "./layout.js";
import { useStatusItems, type StatusItem } from "./useStatusItems.js";

export interface BarProps {
  /** The world's own controls, drawn at the left of each output's bar. */
  start?: ComponentType<{ output: OutputInfo }>;
}

export function Bar({ start }: BarProps) {
  const outputs = useOutputs();
  const items = useStatusItems();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const openings = useRef(0);

  function handlePress(item: StatusItem, output: OutputInfo, right: number) {
    const kind = item.menu;
    if (!kind) {
      item.onPress?.();
      return;
    }
    setMenu((open) =>
      open?.item === item.key && open.output === output.name
        ? null
        : {
            kind,
            item: item.key,
            output: output.name,
            right,
            opened: ++openings.current,
          },
    );
  }

  const closeMenu = () => setMenu(null);

  return (
    <>
      <Reserve top={barLayout.reserve} />
      {outputs.map((output) => (
        <BarStrip
          key={output.name}
          output={output}
          items={items}
          start={start}
          openItem={menu?.output === output.name ? menu.item : null}
          onPress={(item, right) => handlePress(item, output, right)}
          onDismiss={closeMenu}
        />
      ))}
      <BarMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
