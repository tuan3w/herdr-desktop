import { signal } from "nsh";

/**
 * Why a popup opens or closes. Base UI's reasons (`trigger-press`, `trigger-hover`, `outside-press`, `escape-key`,
 * `item-press`, `focus-out`, ...) plus the ones this host adds: `anchor-moved` (the text it hangs from scrolled away: nsh
 * sends no hover event for content moving under a still pointer) and `window-blur`.
 */
export type OpenReason =
  | "trigger-press"
  | "trigger-hover"
  | "trigger-focus"
  | "outside-press"
  | "escape-key"
  | "item-press"
  | "list-navigation"
  | "focus-out"
  | "anchor-moved"
  | "window-blur"
  | "disabled"
  | "imperative"
  | "none";

/** What `onOpenChange` is told, and may veto (Base UI's `eventDetails.cancel()`). */
export interface OpenChange {
  readonly reason: OpenReason;
  readonly canceled: boolean;
  cancel(): void;
}

/**
 * Controlled or uncontrolled open state (Base UI's `useControlled` + `onOpenChange(open, eventDetails)`):
 * - `open` given and not `undefined`: the owner holds the value; `set` only asks, through `onOpenChange`, and the value
 *   changes when the owner passes a new one. Closing in `onOpenChange` of a controlled popup is the owner's call.
 * - `open` absent or `undefined`: the state holds it, starting from `defaultOpen`.
 * `set` returns whether the request went through (it was a change and `onOpenChange` did not cancel it). Reading `open()`
 * inside an effect or a prop tracks it.
 */
export function createOpenState(options: {
  open?: () => boolean | undefined;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
}): { open: () => boolean; set: (open: boolean, reason: OpenReason) => boolean } {
  const own = signal(options.defaultOpen ?? false);
  const open = () => options.open?.() ?? own();
  return {
    open,
    set(next, reason) {
      if (next === open()) return false;
      let canceled = false;
      const change: OpenChange = {
        reason,
        get canceled() {
          return canceled;
        },
        cancel() {
          canceled = true;
        },
      };
      options.onOpenChange?.(next, change);
      if (canceled) return false;
      if (options.open?.() === undefined) own.set(next);
      return true;
    },
  };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a bubble goes, and the `side` and `align` that give it that place. */
export interface BubblePlace {
  side: "top" | "bottom";
  align: "start" | "center" | "end";
  x: number;
  y: number;
  /** The bubble's width: wider than the window less its margins it is made narrower, and its text wraps. */
  width: number;
}

/**
 * Where a tooltip bubble goes so that it never leaves the window (Floating UI's `flip` and `shift`, in the small): the
 * preferred `side` of the anchor, or the other when the bubble does not fit there and does there (when neither, the side
 * with more room, and the bubble is pushed inside along the edge); the preferred `align`, or `start` / `end` when that
 * would run over the left / right margin; finally `x` and `y` are clamped into the window less `margin`. Pure: anchor
 * rect, bubble size and window size in, a position out.
 */
export function placeBubble(input: {
  anchor: Box;
  bubble: { width: number; height: number };
  window: { width: number; height: number };
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  gap?: number;
  margin?: number;
}): BubblePlace {
  const { anchor, window: win } = input;
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 8;
  const width = Math.min(input.bubble.width, Math.max(0, win.width - 2 * margin));
  const height = input.bubble.height;
  const above = anchor.y - gap - margin;
  const below = win.height - (anchor.y + anchor.height) - gap - margin;
  const wanted = input.side ?? "bottom";
  const room = { top: above, bottom: below };
  const other = wanted === "top" ? "bottom" : "top";
  const side = room[wanted] >= height || room[other] <= room[wanted] ? wanted : other;
  const rawY = side === "top" ? anchor.y - gap - height : anchor.y + anchor.height + gap;

  const start = anchor.x;
  const center = anchor.x + (anchor.width - width) / 2;
  const end = anchor.x + anchor.width - width;
  const fits = (x: number) => x >= margin && x + width <= win.width - margin;
  const xs = { start, center, end };
  const preferred = input.align ?? "center";
  let align = preferred;
  if (!fits(xs[preferred])) {
    const order = xs[preferred] < margin ? ["start", "end"] : ["end", "start"];
    align = (order as ("start" | "end")[]).find((a) => fits(xs[a])) ?? (xs[preferred] < margin ? "start" : "end");
  }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    side,
    align,
    width,
    x: clamp(xs[align], margin, win.width - margin - width),
    y: clamp(rawY, margin, win.height - margin - height),
  };
}
