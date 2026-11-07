# Scrolling

What scrolls, how the bar looks, and how a scroll surface keeps the person's place. The bar is installed in `App.tsx` by an effect (`Scrollbar.setTheme(scrollbarTheme(alwaysShowScrollbars()))`), and its look is `lib/scrollbars.ts`. nsh restyles the bars already on screen when the theme is set again (`Core::set_builtin_scrollbars`), so the setting applies at once. nsh 0.4.0 draws it (`crates/nsh-base/src/scrollbar.rs`) over every `Scroll` and `List` in place of the platform's indicator.

## The bar

Why: the platform's indicator was a 16 pt solid grey thumb, always on, flush against content, covering a selected row's highlight and a check mark. It said "something scrolls" at the price of covering the thing you were reading.

| Part | Value | Why |
|---|---|---|
| mode | `scrolling`; `always` when the person turns on Settings, Look, `Always show scrollbars` (`alwaysShowScrollbars` in `lib/settings.ts`) | the bar exists while the view moves and while the pointer is on it, so a screen at rest has no extra edge; the setting is for a person who loses track of how long a list is |
| idle, fade | 800 ms, in 100 ms, out 200 ms | long enough to grab the thumb after a wheel stops, short enough not to linger; reduced motion removes the fade (nsh) |
| thumb | 6 pt, 8 pt under the pointer or while dragged, fully rounded | thin at rest, a bigger target when you reach for it; the width eases on the thumb's own `transition` (nsh keeps its place on another view, so the thumb never trails the content) |
| track | none | a fill is a second edge beside the content |
| inset | 2 pt from the viewport edge on each side (the bar is 12 pt thick) | the thumb never touches the rim or a control that ends at the edge |
| shortest thumb | 32 pt | still easy to grab on a long list |
| colour | `muted-foreground` at 65% in `scrolling` mode, 85% in `always` mode, the full token under the pointer and while dragged | see the decision below |

### The thumb's weight, decided

The owner's complaint was a thick, dark, always-on thumb. Width (6 pt, was 16) and mode (only while scrolling) already answer two of the three; the third is how dark the resting thumb is. 85% of `muted-foreground` is a mid-dark grey on white and still reads as a bar, so the resting thumb in `scrolling` mode is 65%, the weight of a native overlay thumb.

Contrast of the thumb against the grounds a scroller sits on (alpha composited in gamma-encoded sRGB, as the toolkit does, then the WCAG ratio, from the tokens in `theme.json`):

| Alpha | light `background` / `muted` / `accent` | dark `background` / `muted` / `accent` |
|---|---|---|
| 45% | 1.91 / 1.85 / 1.83 | 2.36 / 2.26 / 2.21 |
| 55% | 2.26 / 2.17 / 2.14 | 2.91 / 2.72 / 2.63 |
| 65% | 2.70 / 2.57 / 2.52 | 3.56 / 3.24 / 3.11 |
| 85% | 3.99 / 3.69 / 3.59 | 5.19 / 4.50 / 4.25 |
| 100% (hover, drag) | 5.51 / 4.98 / 4.80 | 6.71 / 5.64 / 5.28 |

Why 3:1 does not bind the 65% thumb: WCAG 1.4.11 asks 3:1 of the parts of a control that a person needs to find it. In `scrolling` mode the bar is feedback that follows a scroll (and the thumb is full token the moment the pointer is on the bar), the same job as a native overlay scroller, which is about 25 to 40% opaque black (2.3 to 2.8:1 on white). Where the bar must be found at rest, in `always` mode, it is a control to find and gets 85%, which is over 3:1 on every ground in both appearances. The 65% light value (2.52 to 2.70) is under 3:1 by design, not by accident; dark is over it on every ground (3.11 to 3.56). 55% was rejected: 2.1 to 2.3 in light is a thumb that disappears on a bright monitor. Recompute when a theme's `muted-foreground` changes. Unverified: how 65% looks in a frame; judge it in a screenshot on nsh 0.4.0.

## Rows under the bar

A scrolling list leaves 12 pt at its end for the bar (`changes-list.tsx` pads its content on the right), so the bar never covers a row's check mark or button. A list that lives in a popup is the popup's business (`design/overlays.md`).

## Keeping the place

- The transcript has two thresholds (`lib/transcript-scroll.ts`). `FOLLOW_PT` (12 pt) is how far from the end the list still pulls the view down as rows grow: one wheel notch up is about 50 pt and means "stay here", and a streaming row must not take the reader back. `AT_END_PT` (64 pt) is when the tab counts as at the end (`atEnd`, the `Jump to latest` pill, the unseen count): the pill does not flicker on a few points of scroll. Between 12 and 64 pt the view stays where the reader put it and the pill stays quiet.
- PageUp, PageDown, Home and End write the offset they scroll to right away. The list reports its scroll at most every 50 ms and a held key repeats every 30, so a key that read the reported offset would lose a page.
- A picker list (`ComposerPicker`, `SlashList`) scrolls to the highlighted row only when it is out of view, to the nearest edge (`revealOffset` of `#kit`, over equal row heights from `offsetsOf`), and tracks the offset from `onScroll`, so a wheel scroll the person made is not undone by the next arrow key.
- `CodeBlock` asks its view to go to a line once the view exists and on the next two frames, not after a guessed delay; a new `goToNonce` asks again for the same line (the file viewer counts every request of the find bar, so "next hit" on the line already shown scrolls back to it). One view serves a block while it is written and after: it reads `follow` when it is made, so a reader at the end stays at the end (two views started again at the top).
- Group headings in the changes list stay at the top while their files scroll under them (`stickyHeaderIndices`, `headings`), with the page background so rows do not show through.

## Decided, not built yet

- A permanently visible thin bar on code, tables and diffs that overflow sideways. nsh's mode is one per theme, so it needs a per-view theme on the view. The code and diff views are drawn in Rust (`native/app/src/highlight/view/render.rs`), whose sideways scroll does not ask for the built-in bar: the edge fade is the only sign of overflow today, and `Always show scrollbars` does not reach them. Whether any bar shows while they scroll is unverified.
- Restoring a chat's place by the top visible row and its offset. The stored anchor is a distance from the end, which is wrong by the difference between estimated and measured row heights; changing it changes the stored format in `lib/view-state.ts`.

## Verification

Nothing here ran against a window: the installed nsh is 0.3.0 and the repo needs 0.4.0, so the bar's look, the contrast numbers' use in a real frame and the keys are unverified until `make` runs on nsh 0.4.0.
