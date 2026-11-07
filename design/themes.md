# Themes

Herdr Desktop ships four themes, each with a light and a dark appearance. The user picks one in Settings and it applies at once; the choice persists (`herdr.settings.v1`, `lib/settings.ts`). A theme is a handful of choices: `lib/theme/build.ts` fixes every lightness and role, so a new theme cannot make text unreadable by accident.

All four share one quiet structure: a white page (charcoal in dark), a sidebar one shade off it, text in two greys, hairline borders, soft grey hover and selected fills. A theme changes only where color is spent:

| Id | Name | Paper tint | Primary | Signal | Radius |
|---|---|---|---|---|---|
| `harbor` (default) | Harbor | warm (hue 90) | petrol teal (205) | vermilion (45) | 0.375rem |
| `container` | Container | cool steel (250) | oxide rust (38) | safety yellow (95) | 0.25rem |
| `chart` | Chart | pale chart (240) | navy (258) | chart magenta (350) | 0.375rem |
| `graphite` | Graphite | near-neutral (260) | graphite (262) | acid lime (125) | 0.375rem |

One theme, one neutral: `build.ts` derives every surface from `paper` and every text and border from `ink`, and Harbor sets both to hue 90, so a second grey in a Harbor window is a bug in a screen (a surface that is not a token), not in the theme. A theme whose `paper` and `ink` hues differ by more than a few degrees (Container: 250 and 255 is fine) makes borders and surfaces disagree.

Color is spent in three places only: **primary** (the one main button, checked boxes, the progress bar, focus), **signal** ("needs you": the count capsule of `Needs you` on the sidebar and the board, dots on a row) and **status text** (failed, unreachable, state tags). Everything else is grey. That restraint is what makes the screen read as calm; a theme that tints the sidebar, the rows or the headings has stopped being a theme and become decoration.

## Add a theme

1. Add a spec to `THEMES` in `lib/theme/themes.ts`: `paper` (hue, and a chroma at or below 0.01), `ink` (text hue), `primary`, `signal` (`lightness` above 0.6 for a pale signal, which gets dark text), `radius`. `status` hue overrides only if a status color collides with the primary (a green primary would collide with `success`).
2. `nsh test`. `lib/theme/theme.test.ts` checks every theme in both appearances: text pairs at 4.5:1 (body 7:1), non-text at 3:1, secondary text on every hover and selected fill, status text on its tint, the sidebar pairs, the terminal tokens. A failure names the pair and the ratio; fix the spec, not the thresholds.
3. It appears in the Settings picker by itself: the picker draws a miniature from the theme's own colors.

If it is the default theme, also run `bun scripts/gen-theme.mjs` so `theme.json` (what nsh starts in, and where token types come from) matches; the same test fails when they disagree.

## Rules

- A theme sets color, radius and nothing else: no theme changes layout, weight or copy.
- Lightness is shared; hue and chroma vary. Contrast lives in the lightness gap, so any hue passes if its steps do (`build.ts` owns the steps).
- Status colors keep their meaning in every theme (success green, warning amber, destructive red, info blue). `signal` is not a status: it means "needs you".
- Never read a color from a theme by name in a screen. Use token classes (`bg-primary`) or `token("primary")`; both follow the theme.

## Terminal colors

The builder also emits 18 terminal tokens per appearance through `lib/theme/terminal.ts` (`terminalTokens`): `term-bg`, `term-fg` and `term-0` to `term-15`. They are the only colors that are not UI semantic tokens, because a program running in a pane chooses its own ANSI colors; the theme only decides what those colors look like. `term-bg` is a shade off the page. The builder aims every text slot above 4.5:1 on `term-bg` (`TERM_MIN_CONTRAST`) and `term-fg` above 7:1. The exceptions are the slots in `TERM_REMAPPED` (dark: 0 and 8; light: 7 and 15): black and bright black on a dark pane, white and bright white on a light one keep their true tone because a terminal also uses them as fills, and the pane component remaps text drawn in them at render time. A theme adds nothing here: hues and chromas of the spec feed `terminalTokens`, and `theme.test.ts` checks the pairs for every theme in both appearances.

## How the switch works (internal API, tested)

nsh has no public API to change the theme while the app runs. Its core does apply the internal `uiTheme` prop wherever it is set (`nsh-core/src/core/mod.rs`, `Prop::UiTheme`): the tokens are replaced, every class naming a token restyles natively, and `token()` follows. `components/kit/theme-root.tsx` sets it once at the root:

- The JSX spread helper reads its object once. Reactivity must come from a **getter** read inside its effect: `{ get uiTheme() { return themeJson(); } }`.
- The JSON replaces nsh's default theme, not `theme.json`, so each theme file is complete: `{ cssVars: { theme, light, dark } }` with the same tokens in every theme (tested).
- Fonts are theme tokens (`font-sans`, `font-mono`); the files are imported in `App.tsx` so they register before the first frame.

`lib/theme/theme.test.ts` opens `lib/theme/probe.tsx`, switches through every theme in both appearances and compares `token("primary")` with the generator's value. If an nsh update changes this behavior, that test fails first. Source: `github.com/longbridge/nsh`, revision of `nsh -V`.
