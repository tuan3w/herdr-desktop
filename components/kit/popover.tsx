import { cleanup, context, effect, type JSX, Scroll, type Signal, signal, Text, View } from "nsh";

import type { Align, OverlayPosition, Placement, ViewRef } from "nsh/types";

import { hoverTransition, POPOVER_LOOK, popupOrigin, popupPresence } from "#lib/motion";

import { EDGE, FOCUS_RING } from "./core";
import { createHover, type HoverTrigger, POINTER_FOCUS_MS } from "./hover";
import { Icon } from "./icon";
import { createOpenState, type OpenChange } from "./popup";
import { Paths } from "./popup-root";
import { type AnchorPolicy, Positioner } from "./positioner";

import type { TriggerFocus } from "./tooltip";

/**
 * A popover (Base UI's `Popover`, non-modal): content anchored to a trigger that the user presses, for what is too big for a
 * tooltip and too small for a dialog (`design/overlays.md`). `trigger` builds the control and is handed what to wire to it
 * (`PopoverTrigger`); the content is `children`, built only while it is open.
 *
 * - **State**: `createOpenState`, so `open`/`defaultOpen` (controlled or not) and `onOpenChange(open, change)` with the
 *   `OpenReason` (`trigger-press`, `trigger-hover`, `outside-press`, `escape-key`, `focus-out`, `anchor-moved`, `disabled`,
 *   `item-press` for `PopoverClose`, `imperative`) that may `cancel()`.
 * - **Dismissal**: a press on the trigger toggles; a press outside, Escape (the top overlay only: a popover inside a popover
 *   closes first), the keyboard focus leaving the trigger and the popup (`usePopover().focus`: nsh tells a `View` with
 *   `onPress` when it takes or loses the focus, an `Overlay` does not), the anchor moving (`anchorPolicy`), `disabled`
 *   turning true, and a dialog opening above it.
 * - **`openOnHover`**: opens after `delay` (300ms) and closes `closeDelay` (0) after the pointer left, which may cross the
 *   gap to the popup (`hover.ts`). A click on the trigger within 500ms of a hover opening keeps it open (Base UI's
 *   "impatient click"), and a click-opened popover never closes because the pointer left. Needs a `PopupRoot` for the safe
 *   zone; without one the popup waits 300ms for the pointer.
 * - **Screen readers**: the popup's name is its `PopoverTitle` (or `label`), its hint the `PopoverDescription`; the trigger
 *   reports `expanded`. The focus stays on the trigger (nsh cannot move it into a view): a keyboard user reaches the
 *   content with Tab only where it spreads `usePopover().focus`.
 * - **Height**: the popup is never taller than the room on the side it was placed (`OverlayPosition.available`, Base UI's
 *   `--available-height`); taller content scrolls inside it, under the title, instead of running off the window.
 * - **Motion**: it fades and scales from the edge at its trigger (the side it was placed on, not the one asked for) and
 *   leaves the same way, quicker; it stays built through the exit and takes no presses (`popupPresence`).
 * - Not taken: `modal` (a `Modal` is the modal one), focus trap, return focus, backdrop, arrow.
 */

/** A click this soon after a hover opened the popover keeps it open (Base UI's `PATIENT_CLICK_THRESHOLD`). */
export const PATIENT_CLICK_MS = 500;
/** A blur counts as leaving only when no control took the focus within this long. */
export const FOCUS_SETTLE_MS = 50;
const POPUP = `min-w-48 max-w-sm gap-1 rounded-lg bg-popover p-3 text-popover-foreground ${EDGE.md}`;

/** What `trigger` wires to the control: its press, its focus, and what to show while open. */
export interface PopoverTrigger {
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
  /** For `accessibilityState={{ expanded }}` and a pressed look. */
  expanded: () => boolean;
  disabled: () => boolean;
}

/** What the content of an open popover may use. */
export interface PopoverHandle {
  close: () => void;
  /** Spread on a control of the content that is a `View` with `onPress`: the popover then stays open while it has the focus. */
  focus: TriggerFocus;
}

interface Scope extends PopoverHandle {
  title: Signal<string | undefined>;
  description: Signal<string | undefined>;
}

const PopoverScope = context<Scope | undefined>(undefined);

/** The popover around the caller (inside its `children`). Throws outside one. */
export function usePopover(): PopoverHandle {
  const scope = PopoverScope();
  if (!scope) throw new Error("usePopover: not inside a Popover");
  return scope;
}

export function Popover(props: {
  trigger: (t: PopoverTrigger) => JSX.Element;
  children?: JSX.Element;
  /** The popup's name for screen readers, when it has no `PopoverTitle`. */
  label?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  disabled?: boolean;
  side?: Placement;
  align?: Align;
  offset?: number;
  margin?: number;
  /** `"close"` (default): the popover ends when its trigger moves. `"follow"`: only for a trigger nothing scrolls. */
  anchorPolicy?: AnchorPolicy;
  openOnHover?: boolean;
  delay?: number;
  closeDelay?: number;
  /** Extra classes of the popup (a width). */
  popupClass?: string;
  /** Layout classes of the trigger's wrapper (`self-start` by default: the popup is lined up with the trigger, not its row). */
  class?: string;
}) {
  let openedAt = 0;
  let byHover = false;
  let pressedAt = Number.NEGATIVE_INFINITY;
  let within = 0;
  let settling: number | undefined;
  /** The room on the side the popup was placed: it is cut to it (the content scrolls). */
  const room = signal<number | undefined>(undefined);
  /** The side it was really placed on (it flips when it does not fit): its scale grows from the edge at the trigger. */
  const placedSide = signal<Placement>(props.side ?? "bottom");
  const placed = (p: OverlayPosition) => {
    hover.placed(p);
    room.set(Math.floor(p.available.height));
    placedSide.set(p.placement);
  };

  const state = createOpenState({
    open: () => props.open,
    defaultOpen: props.defaultOpen,
    onOpenChange(open, change) {
      props.onOpenChange?.(open, change);
      if (!open || change.canceled) return;
      openedAt = Date.now();
      byHover = change.reason === "trigger-hover";
      if (!byHover) hover.stick();
    },
  });
  const node: HoverTrigger = {
    node: undefined,
    disabled: () => props.disabled ?? false,
    get delay() {
      return props.delay;
    },
    get closeDelay() {
      return props.closeDelay;
    },
  };
  const hover = createHover({ state, delay: 300, closeDelay: 0, group: 0, focusDelay: 0, hoverable: true });
  const events = hover.register(node);
  const unwatch = Paths()?.add(hover);
  cleanup(() => {
    events.gone();
    unwatch?.();
    clearTimeout(settling);
  });
  effect(() => hover.sync());
  // Occasional and pointer-opened, so it has an exit (menus, selects, tooltips and the palette open and close at once:
  // `design/motion.md`). It stays built through it, takes no presses, and opening again cancels the unbuild.
  const presence = popupPresence(state.open, POPOVER_LOOK);
  effect(() => {
    if (props.disabled && state.open()) hover.hide("disabled");
  });

  const settle = () => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      if (within <= 0 && state.open() && Date.now() - pressedAt > POINTER_FOCUS_MS) hover.hide("focus-out");
    }, FOCUS_SETTLE_MS);
  };
  const focus: TriggerFocus = {
    onFocus: () => {
      within++;
    },
    onBlur: () => {
      within = Math.max(0, within - 1);
      settle();
    },
  };
  const scope: Scope = {
    close: () => hover.hide("item-press"),
    focus,
    title: signal<string | undefined>(undefined),
    description: signal<string | undefined>(undefined),
  };
  const press = () => {
    if (props.disabled) return;
    if (!state.open()) {
      state.set(true, "trigger-press");
    } else if (byHover && Date.now() - openedAt < PATIENT_CLICK_MS) {
      byHover = false;
      hover.stick();
    } else {
      hover.hide("trigger-press");
    }
  };
  const handle: PopoverTrigger = {
    onPress: press,
    onFocus: focus.onFocus!,
    onBlur: focus.onBlur!,
    expanded: state.open,
    disabled: () => props.disabled ?? false,
  };

  return (
    <View
      ref={(n: ViewRef) => {
        node.node = n;
      }}
      onMouseEnter={props.openOnHover ? events.enter : undefined}
      onMouseLeave={props.openOnHover ? events.leave : undefined}
      onTouchStartCapture={() => {
        pressedAt = Date.now();
      }}
      class={props.class ?? "self-start"}
    >
      {props.trigger(handle)}
      <If when={presence.mounted()}>
        <PopoverScope.Provider value={scope}>
          <Positioner
            anchor={node.node}
            side={props.side ?? "bottom"}
            align={props.align ?? "center"}
            offset={props.offset}
            margin={props.margin}
            policy={props.anchorPolicy}
            noPointer={presence.closing()}
            label={scope.title() ?? props.label}
            hint={scope.description()}
            onPressOutside={() => hover.hide("outside-press")}
            onCancel={() => hover.hide("escape-key")}
            onPressCapture={() => {
              pressedAt = Date.now();
            }}
            onAnchorMoved={hover.moved}
            onPosition={placed}
            onMouseEnter={props.openOnHover ? hover.popupEnter : undefined}
            onMouseLeave={props.openOnHover ? hover.popupLeave : undefined}
            class={`${POPUP} ${room() === undefined ? "" : `max-h-[${room()}px]`} ${props.popupClass ?? ""}`}
            style={{ ...presence.style, transformOrigin: popupOrigin(placedSide(), props.align ?? "center") }}
          >
            <Scroll class="min-h-0 shrink" contentClass="gap-1">
              {props.children}
            </Scroll>
          </Positioner>
        </PopoverScope.Provider>
      </If>
    </View>
  );
}

/**
 * A popover's panel drawn in place, with the surface of the real one: for a lab or a spec page, because the host's window
 * screenshot does not draw an overlay. `PopoverTitle` and `PopoverDescription` work inside it; `PopoverClose` does not.
 */
export function PopoverPreview(props: { children?: JSX.Element; class?: string }) {
  return <View class={`self-start ${POPUP} ${props.class ?? ""}`}>{props.children}</View>;
}

/** The popup's heading: names the popup for screen readers (Base UI's `Popover.Title`). */
export function PopoverTitle(props: { children: string; class?: string }) {
  const scope = PopoverScope();
  effect(() => {
    scope?.title.set(props.children);
    return () => scope?.title.set(undefined);
  });
  return (
    <Text role="header" class={`text-sm font-medium text-popover-foreground ${props.class ?? ""}`}>
      {props.children}
    </Text>
  );
}

/** What the popup is for, under its title: read by screen readers as the popup's hint (Base UI's `Popover.Description`). */
export function PopoverDescription(props: { children: string; class?: string }) {
  const scope = PopoverScope();
  effect(() => {
    scope?.description.set(props.children);
    return () => scope?.description.set(undefined);
  });
  return <Text class={`text-sm text-muted-foreground ${props.class ?? ""}`}>{props.children}</Text>;
}

/** A close button for the corner of the popup (Base UI's `Popover.Close`); `label` is its name. */
export function PopoverClose(props: { label?: string; class?: string }) {
  const scope = usePopover();
  return (
    <View
      role="button"
      accessibilityLabel={props.label ?? "Close"}
      onPress={scope.close}
      onFocus={scope.focus.onFocus}
      onBlur={scope.focus.onBlur}
      style={hoverTransition()}
      class={`size-8 items-center justify-center rounded-md hover:bg-accent ${FOCUS_RING} ${props.class ?? ""}`}
    >
      <Icon name="x" tone="muted-foreground" />
    </View>
  );
}
