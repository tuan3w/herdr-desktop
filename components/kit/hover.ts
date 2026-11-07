import { signal } from "nsh";
import type { OverlayPosition, Placement, Point, ViewRef } from "nsh/types";
import { dialogDepth } from "./dialog-stack";
import type { OpenReason } from "./popup";
import { inSafeZone, type Rect } from "./positioner";

/**
 * When a popup opened by the pointer or by keyboard focus opens and closes: Base UI's `useHoverTriggerInteraction`,
 * `useHoverPopupInteraction`, `useFocus` and the `FloatingDelayGroup`, as one engine for the tooltip, the preview card and
 * a popover with `openOnHover`. It holds no view and no handler of its own: a skin gives each trigger the few functions
 * `register` returns, and renders one popup for `active()`.
 *
 * - **One popup, many triggers.** `active()` is the trigger the popup hangs from; moving to another trigger while open
 *   moves the popup and is not an open change.
 * - **Delay and group.** A trigger waits its `delay` (or the engine's) once the pointer is on it. While a popup is open, or
 *   the pointer left one less than `group` ms ago, the next opens at once. A popup ended by a press, a scroll or Escape
 *   does not start a group: the next trigger waits its turn.
 * - **Nested triggers.** The pointer on a trigger inside another opens the inner one; leaving the inner one for the outer
 *   one opens the outer one again (`hovered` is the stack of triggers under the pointer).
 * - **Hoverable popups.** The pointer may travel to the popup: once it leaves the trigger, the popup stays while the pointer
 *   is in the safe zone between them (`track`, fed by the root's hover move while `tracking()`), over the popup
 *   (`popupEnter`), or for `closeDelay`. A hoverable popup can `stick`: a click made it independent of the pointer.
 * - **Focus.** A trigger that took the keyboard focus opens (after `focusDelay`) and closes when it loses it; the focus a
 *   press gives does not count (`POINTER_FOCUS_MS`).
 * - The state itself is a `createOpenState`: every change carries its reason and may be vetoed or controlled by the owner.
 */

/** A focus this soon after a press is the press's own, not the keyboard's. */
export const POINTER_FOCUS_MS = 250;
/** A hoverable popup waits this long for a pointer that left its trigger toward it to arrive, and for one that stopped in the gap. */
export const TRANSIT_MS = 300;

/** What a trigger says about itself: everything but the node is optional (a trigger that never says gets the engine's defaults). */
export interface HoverTrigger {
  node: ViewRef | undefined;
  /** No popup while true; read when needed. */
  disabled?: () => boolean;
  /** Milliseconds of rest before opening, over the engine's. */
  delay?: number;
  /** Milliseconds before closing after the pointer left, over the engine's. */
  closeDelay?: number;
  /** A press on the trigger ends its popup (default true). */
  closeOnClick?: boolean;
}

export interface HoverOptions {
  state: { open: () => boolean; set: (open: boolean, reason: OpenReason) => boolean };
  /** How long the pointer rests on a trigger before the first popup opens. */
  delay: number;
  /** How long after the pointer left the trigger the popup closes. */
  closeDelay: number;
  /** After a popup closed because the pointer left, the next opens at once for this long (0: no group). */
  group: number;
  /** How long a trigger that took the keyboard focus waits to open. */
  focusDelay: number;
  /** The pointer may go onto the popup. */
  hoverable: boolean;
  /** The frame of a trigger in the root view, for the safe zone. */
  measure?: (node: ViewRef) => Promise<Rect | null>;
}

/** What a skin wires to one trigger: events of its view, and `gone` for when its owner is disposed. */
export interface HoverHandlers {
  enter: () => void;
  leave: () => void;
  focus: () => void;
  blur: () => void;
  gone: () => void;
}

/** What the root view needs of a popup that follows the pointer to its safe zone. */
export interface Followed {
  /** Whether the root's hover move should be fed to `track`. */
  tracking: () => boolean;
  /** The pointer moved (in the root view) while `tracking()`: still on its way to the popup, or not. */
  track: (at: Point) => void;
}

export interface Hover<T extends HoverTrigger = HoverTrigger> extends Followed {
  /** The trigger the popup hangs from, while it is open. */
  active: () => T | null;
  open: () => boolean;
  /** Why the popup is open now. */
  reason: () => OpenReason;
  register: (t: T) => HoverHandlers;
  popupEnter: () => void;
  popupLeave: () => void;
  stick: () => void;
  press: () => void;
  escape: () => void;
  placed: (p: OverlayPosition) => void;
  moved: () => void;
  hide: (reason: OpenReason, warm?: boolean) => void;
  sync: () => void;
}

async function measureNode(node: ViewRef): Promise<Rect | null> {
  const m = await node.measure();
  return m ? { x: m.pagePosition.x, y: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height } : null;
}

export function createHover<T extends HoverTrigger>(o: HoverOptions): Hover<T> {
  const active = signal<T | null>(null);
  const tracking = signal(false);
  let hovered: T[] = [];
  let focused: T | undefined;
  let waiting: T | undefined;
  let timer: number | undefined;
  let leftAt = Number.NEGATIVE_INFINITY;
  /** How many dialogs were open when the popup opened: one that opens after it covers it. */
  let openDepth: number | undefined;
  let pressedAt = Number.NEGATIVE_INFINITY;
  let why: OpenReason = "none";
  let overPopup = false;
  let stuck = false;
  let apex: Point | undefined;
  let triggerRect: Rect | undefined;
  let popupRect: Rect | undefined;
  let side: Placement = "bottom";

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
    waiting = undefined;
  };
  const stopTracking = () => {
    tracking.set(false);
    apex = undefined;
  };

  /** Closes the popup now. `warm`: the pointer left, so the next trigger opens at once. */
  function hide(reason: OpenReason, warm = false) {
    openDepth = undefined;
    cancelTimer();
    stopTracking();
    overPopup = false;
    stuck = false;
    if (o.state.open() && !o.state.set(false, reason)) return;
    if (!o.state.open()) active.set(null);
    leftAt = warm ? Date.now() : Number.NEGATIVE_INFINITY;
  }

  function show(t: T, reason: OpenReason) {
    if (!t.node) return;
    cancelTimer();
    stopTracking();
    overPopup = false;
    stuck = false;
    why = reason;
    // The state first: `sync` clears the active trigger of a popup that is not open.
    if (!o.state.open() && !o.state.set(true, reason)) return;
    active.set(t);
  }

  const grouped = () => o.state.open() || Date.now() - leftAt < o.group;

  function arm(t: T) {
    const ms = t.delay ?? o.delay;
    if (grouped() || ms <= 0) {
      show(t, "trigger-hover");
      return;
    }
    waiting = t;
    timer = setTimeout(() => show(t, "trigger-hover"), ms);
  }

  /** The pointer is gone for good: close, and open the trigger it is still over (the outer one of two nested). */
  function closeByPointer() {
    hide("trigger-hover", true);
    const outer = hovered[hovered.length - 1];
    if (outer && !outer.disabled?.()) arm(outer);
  }

  function scheduleClose(t: T) {
    cancelTimer();
    const ms = t.closeDelay ?? o.closeDelay;
    if (!o.hoverable) {
      if (ms <= 0) closeByPointer();
      else timer = setTimeout(closeByPointer, ms);
      return;
    }
    tracking.set(true);
    triggerRect = undefined;
    if (t.node) void (o.measure ?? measureNode)(t.node).then((r) => (triggerRect = r ?? undefined));
    timer = setTimeout(closeByPointer, Math.max(ms, TRANSIT_MS));
  }

  return {
    /** The trigger the popup hangs from, while it is open. */
    active: () => active(),
    /** Whether the root's hover move should be fed to `track`. */
    tracking: () => tracking(),
    open: () => o.state.open(),
    /** Why the popup is open now. */
    reason: () => why,

    /** What a skin wires to one trigger: its view's `ref` and its events. */
    register(t: T) {
      return {
        enter() {
          hovered = [...hovered.filter((x) => x !== t), t];
          if (t.disabled?.()) {
            if (o.state.open() && active() !== t) hide("trigger-hover");
            return;
          }
          if (o.state.open() && (active() === t || stuck)) {
            cancelTimer();
            stopTracking();
            return;
          }
          cancelTimer();
          arm(t);
        },
        leave() {
          hovered = hovered.filter((x) => x !== t);
          if (waiting === t) cancelTimer();
          if (active() !== t || !o.state.open() || stuck || focused === t) return;
          scheduleClose(t);
        },
        focus() {
          if (t.disabled?.() || Date.now() - pressedAt < POINTER_FOCUS_MS) return;
          focused = t;
          if (o.state.open() && active() === t) return;
          if (o.focusDelay <= 0) {
            show(t, "trigger-focus");
            return;
          }
          cancelTimer();
          waiting = t;
          timer = setTimeout(() => show(t, "trigger-focus"), o.focusDelay);
        },
        blur() {
          if (focused === t) focused = undefined;
          if (waiting === t) cancelTimer();
          if (active() === t && o.state.open() && why === "trigger-focus") hide("trigger-focus");
        },
        /** The trigger's owner is gone: its popup and its pending open go with it. */
        gone() {
          hovered = hovered.filter((x) => x !== t);
          if (focused === t) focused = undefined;
          if (waiting === t) cancelTimer();
          if (active() === t && o.state.open()) hide("none");
        },
      };
    },

    /** The pointer is over the popup (hoverable popups). */
    popupEnter() {
      overPopup = true;
      cancelTimer();
      stopTracking();
    },
    popupLeave() {
      overPopup = false;
      const t = active();
      if (!t || !o.state.open() || stuck || hovered.includes(t)) return;
      scheduleClose(t);
    },
    /** A click made the popup independent of the pointer: it stays until something closes it. */
    stick() {
      stuck = true;
      cancelTimer();
      stopTracking();
    },

    /** The pointer moved while `tracking()`: still on its way to the popup, or not. */
    track(at: Point) {
      const t = active();
      if (!tracking() || !t) return;
      apex ??= at;
      const inZone = !triggerRect || !popupRect || inSafeZone(apex, triggerRect, popupRect, side, at);
      const ms = t.closeDelay ?? o.closeDelay;
      clearTimeout(timer);
      if (inZone) timer = setTimeout(closeByPointer, Math.max(ms, TRANSIT_MS));
      else if (ms <= 0) closeByPointer();
      else timer = setTimeout(closeByPointer, ms);
    },
    /** Any press in the root view (capture): ends the popup unless it is on the popup, or on a trigger that ignores clicks. */
    press() {
      pressedAt = Date.now();
      if (overPopup) return;
      const a = active();
      const onTrigger = a !== null && hovered.includes(a);
      if (o.state.open()) {
        if (onTrigger && !(a.closeOnClick ?? true)) return;
        hide(onTrigger ? "trigger-press" : "outside-press");
      } else if (waiting && (waiting.closeOnClick ?? true)) cancelTimer();
    },
    escape() {
      hide("escape-key");
    },
    /** The overlay was placed (again). */
    placed(p: OverlayPosition) {
      popupRect = { x: p.bounds.origin.x, y: p.bounds.origin.y, width: p.bounds.size.width, height: p.bounds.size.height };
      side = p.placement;
    },
    /** The anchor moved (`Positioner`'s policy): a popup hung from it is out of place. */
    moved() {
      hide("anchor-moved");
    },
    /** Closes now, for a reason the owner gives. */
    hide,
    /** Re-reads what the triggers and the owner say: a trigger that became disabled, a popup the owner closed. Run it in an effect. */
    sync() {
      const a = active();
      const depth = dialogDepth();
      if (!o.state.open()) {
        openDepth = undefined;
        stuck = false;
        overPopup = false;
        stopTracking();
        if (a && !waiting) active.set(null);
        return;
      }
      openDepth ??= depth;
      if (depth > openDepth) hide("imperative");
      else if (a?.disabled?.()) hide("disabled");
    },
  };
}
