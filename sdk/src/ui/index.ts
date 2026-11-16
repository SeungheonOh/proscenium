// proscenium/ui: controls and surfaces built from the SDK's own nodes, in the
// manner of React Native: themes, StyleSheet and variants, layout and text,
// controls, menus and other floating surfaces, and feedback.
//
// Styling: every component takes `style` for its root and a style per part
// (`labelStyle`, `knobStyle`, …), each an object, a list, or a function of the
// control's state; looks come from the theme in effect (`ThemeProvider`).
//
// Efficiency rules every piece follows: styles are made once per theme, never per
// render; a control's looks under the pointer, held and focused are `states` the
// compositor resolves itself, so hovering and pressing render nothing, and nothing
// renders on pointer motion but a drag; changes animate in the compositor through
// `transition`, never by rendering frames; and a still interface costs nothing: no
// timers are left running and nothing loops but the theme's `breathe`.
//
// Floating surfaces (menus, popovers, tooltips, dialogs) mount in the layer an
// <OverlayHost> near the root provides, through a portal.

export { breathe, colors, controls, createTheme, darkTheme, font, glassBorder, lightTheme, makeStyles, motion, radii,
  shadows, space, ThemeProvider, type, useTheme } from "./theme.js";
export type { TextKeymap } from "./theme.js";
export type { ControlSizes, TextRole, Theme, ThemeColors, ThemeOverrides } from "./theme.js";
export { resolveStyle, StyleSheet, variants } from "./styles.js";
export type { AnyStyle, BoxStyle, StateStyle, TextStyle } from "./styles.js";
export { Badge, Column, Divider, Icon, Label, Pill, Row, Surface } from "./views.js";
export type { BadgeProps, BadgeTone, DividerProps, IconProps, LabelProps, LabelVariant, PillProps, SurfaceProps,
  SurfaceVariant, Tone } from "./views.js";
export { Pressable } from "./Pressable.js";
export type { PressableProps, PressState } from "./Pressable.js";
export { Button, Checkbox, IconButton, ProgressBar, SegmentedControl, Slider, sliderKey, Switch } from "./controls.js";
export type { ButtonProps, ButtonSize, ButtonVariant, CheckboxProps, CheckboxState, ControlState, IconButtonProps,
  ProgressBarProps, SegmentedControlProps, SliderProps, SliderState, SwitchProps, SwitchState } from "./controls.js";
export { Glyph } from "./glyphs.js";
export type { GlyphProps, GlyphShape } from "./glyphs.js";
export { Dismisser, Floating, Overlay, OverlayHost, Popover, resolveAnchor } from "./overlay.js";
export type { Anchor, FloatingProps, PopoverProps } from "./overlay.js";
export { anchorRect, place, rememberAnchor } from "./placement.js";
export type { Align, Bounds, OutputRect, Placement, PlaceOptions, Side } from "./placement.js";
export { ContextMenu, Menu, menuEntries, MenuItem, MenuLabel, MenuSeparator, Submenu, useContextMenu } from "./Menu.js";
export type { ContextMenuProps, MenuEntry, MenuItemProps, MenuProps, SubmenuProps } from "./Menu.js";
export { moveIndex, typeahead, TypeaheadBuffer } from "./navigation.js";
export { Tooltip } from "./Tooltip.js";
export type { TooltipProps } from "./Tooltip.js";
export { MenuButton, Select } from "./Select.js";
export type { MenuButtonProps, SelectOption, SelectProps } from "./Select.js";
export { Dialog } from "./Dialog.js";
export type { DialogProps } from "./Dialog.js";
export { Tabs } from "./Tabs.js";
export type { TabOption, TabsProps } from "./Tabs.js";
export { List, ListItem } from "./List.js";
export type { ListItemProps, ListProps } from "./List.js";
export { blurTextFields, TextField } from "./TextField.js";
export type { TextFieldHandle, TextFieldProps, TextFieldState } from "./TextField.js";
export { ScrollView } from "./ScrollView.js";
export type { ScrollViewHandle, ScrollViewProps } from "./ScrollView.js";
export { Toast, useRetained, useToast } from "./Toast.js";
export type { ToastMessage, ToastProps } from "./Toast.js";
export { Spacer } from "../components.js";
