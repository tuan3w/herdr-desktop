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
