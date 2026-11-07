import type { ScrollbarTheme } from "nsh/base";

// The bar is 12 pt thick over the viewport's edge: an inset of 2 on each side around a thumb of 6 at rest, 8 under the
// pointer (the widest), so the bar never grows into the content and never touches a control that ends at the edge.
// The thumb is the muted foreground. While the bar shows only as the view scrolls it is a progress indicator, not a
// control to find: 65% (2.7:1 on `background` in light, 3.6 in dark), about the weight of a native overlay thumb, so it
// is not the heavy dark bar a resting 85% reads as. The person who turns "Always show scrollbars" on has a bar that has
// to be found at rest: 85% there (4.0:1 light, 5.2 dark, over the 3:1 WCAG 1.4.11 asks of a control). Under the
// pointer and while dragged it is the full token (4.8:1 light at the worst, 5.3 dark) in both modes. No track fill: a
// fill is a second edge beside the content. Numbers: `design/scroll.md`.
const THUMB_SCROLLING = "bg-muted-foreground/65";
const THUMB_ALWAYS = "bg-muted-foreground/85";
const thumb = (always: boolean) =>
  `rounded-full ${always ? THUMB_ALWAYS : THUMB_SCROLLING} hover:bg-muted-foreground active:bg-muted-foreground`;
// Only the thumb's own `transition` widens it: the bar keeps the thumb's place on a view of its own, so the
// transition never makes it trail the content. Reduced motion drops it.
const EASE = "transition-all duration-150 ease-out motion-reduce:transition-none";

const vertical = (always: boolean) => ({
  class: "absolute inset-y-0 right-0 w-3 items-end p-0.5",
  thumbClass: `w-1.5 hover:w-2 active:w-2 ${thumb(always)} ${EASE}`,
});
const horizontal = (always: boolean) => ({
  class: "absolute inset-x-0 bottom-0 h-3 items-end p-0.5",
  thumbClass: `h-1.5 hover:h-2 active:h-2 ${thumb(always)} ${EASE}`,
});

const MOTION = { idle: 800, enter: 100, exit: 200 } as const;

/**
 * The app's scroll bars, for `Scrollbar.setTheme` at the root: a thin thumb that shows while the view scrolls and while
 * the pointer is on it (a vertical bar), and goes after 800 ms. `always` is the person's "Always show scrollbars".
 */
export function scrollbarTheme(always = false): ScrollbarTheme {
  return {
    mode: always ? "always" : "scrolling",
    motion: MOTION,
    minThumbLength: 32,
    vertical: vertical(always),
    horizontal: horizontal(always),
  };
}
