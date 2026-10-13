// Host components. Each renders one scene node of the same name.

import { createElement, type FC } from "react";
import type { BackgroundProps, BoxProps, CameraProps, GestureBindingProps, GroupProps, HostType,
  ImageProps, PointerBindingProps, RectProps, ReserveProps, ScreenProps, ShortcutProps,
  TextProps, WheelBindingProps, WindowProps } from "./props.js";

function host<P>(type: HostType): FC<P> {
  return type as unknown as FC<P>;
}

/** Transform container; children are positioned in its local space. */
export const Group = host<GroupProps>("group");
/** Rounded rectangle with optional border and soft shadow. */
export const Rect = host<RectProps>("rect");
/**
 * A Rect that lays out its children like a `display: flex` div:
 * `<Box flexDirection="column" padding={8} gap={4}>`. A Box inside a Box is
 * laid out with it; an outermost Box is placed by its own x/y.
 */
export const Box = host<BoxProps>("box");
/** Takes up the free space along its Box's main axis, pushing its siblings apart. */
export function Spacer() {
  return createElement(Box, { flexGrow: 1 });
}
/** Text laid out by Pango; `<Text size={14}>Hello {name}</Text>`. */
export const Text = host<TextProps>("text");
/** Decoded image file, optionally rounded, bordered and shadowed like a Rect. */
export const Image = host<ImageProps>("image");
/** A client window, configured to `width` x `height` when both are given. */
export const Window = host<WindowProps>("window");
/** Infinite plane with an optional dot or line grid; the natural target for canvas gestures. */
export const Background = host<BackgroundProps>("background");
/** Camera of one output, or of every output without its own. */
export const Camera = host<CameraProps>("camera");
/** Children in an output's logical pixels, unaffected by the camera. */
export const Screen = host<ScreenProps>("screen");
/** Screen space kept for this world's own UI; windows' work areas leave it free. */
export const Reserve = host<ReserveProps>("reserve");
/** Keyboard shortcut, consumed before the focused window sees it. */
export const Shortcut = host<ShortcutProps>("shortcut");
/** Modifier+button drag anywhere, e.g. Super+drag to move windows. */
export const PointerBinding = host<PointerBindingProps>("pointer-binding");
/** Modifier+wheel anywhere, e.g. Super+wheel to zoom. */
export const WheelBinding = host<WheelBindingProps>("wheel-binding");
/** Touchpad swipe, pinch or hold gesture. */
export const GestureBinding = host<GestureBindingProps>("gesture-binding");
