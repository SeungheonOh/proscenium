// proscenium/ui: controls and surfaces built from the SDK's own nodes, in the
// manner of React Native: themes, StyleSheet and variants, layout and text,
// pressables with hover and press, and feedback.
//
// Styling: every component takes `style` for its root and a style per part
// (`labelStyle`, `knobStyle`, …), each an object, a list, or a function of the
// control's state; looks come from the theme in effect (`ThemeProvider`).
//
// Efficiency rules every piece follows: styles are made once per theme, never per
// render; hover and press state live in the control they change, so only it
// renders, and never on pointer motion; and changes animate in the compositor
// through `transition`, never by rendering frames.

export { colors, createTheme, darkTheme, font, glassBorder, lightTheme, makeStyles, motion, radii, shadows, space,
  ThemeProvider, type, useTheme } from "./theme.js";
export type { TextRole, Theme, ThemeColors, ThemeOverrides } from "./theme.js";
export { resolveStyle, StyleSheet, variants } from "./styles.js";
export type { AnyStyle, BoxStyle, StateStyle, TextStyle } from "./styles.js";
export { Badge, Column, Divider, Icon, Label, Pill, Row, Surface } from "./views.js";
export type { BadgeProps, BadgeTone, DividerProps, IconProps, LabelProps, LabelVariant, PillProps, SurfaceProps,
  SurfaceVariant, Tone } from "./views.js";
export { Pressable } from "./Pressable.js";
export type { PressableProps, PressState } from "./Pressable.js";
export { Button, Checkbox, IconButton, ProgressBar, SegmentedControl, Slider, Switch } from "./controls.js";
export type { ButtonProps, ButtonVariant, CheckboxProps, CheckboxState, ControlState, IconButtonProps, ProgressBarProps,
  SegmentedControlProps, SliderProps, SliderState, SwitchProps, SwitchState } from "./controls.js";
export { blurTextFields, TextField } from "./TextField.js";
export type { TextFieldHandle, TextFieldProps, TextFieldState } from "./TextField.js";
export { ScrollView } from "./ScrollView.js";
export type { ScrollViewHandle, ScrollViewProps } from "./ScrollView.js";
export { Toast, useRetained, useToast } from "./Toast.js";
export type { ToastMessage, ToastProps } from "./Toast.js";
export { Spacer } from "../components.js";
