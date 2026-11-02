// Styles as React Native writes them: named objects made once at module level and
// passed through `style`, which takes an object or a list of them (later entries
// win, and the element's own props win over all).

import type { BoxProps, Style, TextProps } from "../props.js";

type Handlers = `on${string}`;

/** What a Box's `style` may set: everything but its children, ref and handlers. */
export type BoxStyle = Omit<BoxProps, "children" | "ref" | "style" | Handlers>;

/** What a Text's `style` may set: everything but its content, ref and handlers. */
export type TextStyle = Omit<TextProps, "children" | "text" | "ref" | "style" | Handlers>;

export const StyleSheet = {
  /**
   * Named styles, checked as Box or Text styles and returned as they are:
   * `const styles = StyleSheet.create({ row: { flexDirection: "row", gap: 8 } })`.
   */
  create<T extends Record<string, BoxStyle | TextStyle>>(styles: T): Readonly<T> {
    return Object.freeze(styles);
  },
};

/** Any Box or Text style, as variants hold them. */
export type AnyStyle = Style<BoxStyle & TextStyle>;

/** A variant's name; a variant named "true" or "false" is also picked with a boolean. */
type Pick<Names> = Names | (Names extends "true" | "false" ? boolean : never);

type Choices<V> = { [K in keyof V]?: Pick<keyof V[K]> | null };

/** A combination: each named variant must be the one given, or one of a list. */
type When<V> = { [K in keyof V]?: Pick<keyof V[K]> | readonly Pick<keyof V[K]>[] };

interface VariantConfig<V extends Record<string, Record<string, AnyStyle>>> {
  /** Under every variant. */
  base?: AnyStyle;
  /** Styles by variant: `{ tone: { plain: …, filled: … }, selected: { true: … } }`. */
  variants: V;
  /** The variant each takes when a choice leaves it out. */
  defaults?: Choices<V>;
  /** Styles for combinations, over the variants' own: `{ when: { tone: "filled", look: "hover" }, style: … }`. */
  compound?: readonly { when: When<V>; style: AnyStyle }[];
}

/**
 * A function from variant choices to a style list, like class-variance-authority:
 *
 *     const button = variants({ base: styles.button,
 *       variants: { tone: { plain: {}, filled: styles.filled }, selected: { true: styles.selected } },
 *       defaults: { tone: "plain" },
 *       compound: [{ when: { tone: "filled", selected: true }, style: styles.filledSelected }] });
 *     <Box style={button({ tone, selected })} />
 *
 * Lists are made once per combination and kept, so the same choices always give
 * the very same list, and choosing makes no new style objects.
 */
export function variants<V extends Record<string, Record<string, AnyStyle>>>(
  config: VariantConfig<V>,
): (choices?: Choices<V>) => AnyStyle {
  const names = Object.keys(config.variants) as (keyof V & string)[];
  const made = new Map<string, AnyStyle>();
  return (choices = {}) => {
    const picked = names.map((name) => {
      const choice = choices[name] ?? config.defaults?.[name];
      return choice === undefined || choice === null ? "" : String(choice);
    });
    const key = picked.join("\u0000");
    let style = made.get(key);
    if (!style) {
      const list: AnyStyle[] = [config.base];
      names.forEach((name, index) => list.push(config.variants[name]![picked[index]!]));
      for (const { when, style } of config.compound ?? []) {
        const matches = Object.entries(when).every(([name, wanted]) => {
          const choice = picked[names.indexOf(name as keyof V & string)];
          return (Array.isArray(wanted) ? wanted : [wanted]).some((value) => String(value) === choice);
        });
        if (matches) list.push(style);
      }
      style = Object.freeze(list);
      made.set(key, style);
    }
    return style;
  };
}

/** A style, or a function of a control's state giving one: `({ hovered }) => hovered && styles.lit`. */
export type StateStyle<P, S> = Style<P> | ((state: S) => Style<P>);

/** STYLE for STATE. */
export function resolveStyle<P, S>(style: StateStyle<P, S> | undefined, state: S): Style<P> {
  return typeof style === "function" ? style(state) : style;
}
