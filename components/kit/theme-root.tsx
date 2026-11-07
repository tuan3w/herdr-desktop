import { type JSX, View } from "nsh";

import { themeJson } from "#lib/settings";

/**
 * nsh has no public API to change the theme while the app runs, but its core applies the internal `uiTheme` prop
 * wherever it is set (`nsh-core/src/core/mod.rs`, `Prop::UiTheme`): the tokens are replaced, every class naming a
 * token restyles natively, and `token()` follows. Two facts keep this working:
 *  - the JSX spread helper reads its object once, so reactivity must come from a getter, read inside its effect;
 *  - the JSON replaces nsh's default theme, not `theme.json`, so each theme is complete (`lib/theme/build.ts`).
 * `theme.test.ts` and the "switching the theme" test fail loudly if a nsh update changes this.
 */
const ROOT = {
  get uiTheme() {
    return themeJson();
  },
} as object;

/** Mounted once at the root of the app: every token class and `token()` below it follows `themeId()`. */
export function ThemeRoot(props: { children?: JSX.Element }) {
  return (
    <View {...ROOT} class="flex-1">
      {props.children}
    </View>
  );
}
