import { cleanup, context, effect, type JSX, signal, Text, View, windowSize } from "nsh";

import type { ViewRef } from "nsh/types";

import { createHover, type Hover, type HoverTrigger } from "./hover";
import { Keys } from "./keys";
import { type BubblePlace, createOpenState, type OpenChange, placeBubble } from "./popup";
import { Positioner } from "./positioner";

/**
 * Tooltips, built the way Base UI builds its Tooltip and shaped by what this host needs (`design/overlays.md`).
 *
 * - **One popup for many triggers** (Base UI: a `handle` shared by detached triggers with a payload). A trigger is a view
 *   with a ref and two hover handlers; the bubble is one `Positioner` per root view, mounted only while something is shown.
 *   nsh's own `tooltip` prop makes a hint overlay inside every element that has one, which costs memory and nodes per row
 *   of a list. The timing is `hover.ts`'s: delay, a delay group (Base UI's `Tooltip.Provider`), per-trigger `delay`,
 *   `closeDelay`, `disabled` and `closeOnClick`, and the reasons of `OpenReason` on a `createOpenState`.
 * - **Dismissal** (Base UI's `useDismiss`): the pointer leaving the trigger, any press (`onTouchStartCapture` on the root),
 *   Escape, the trigger going away, and **the anchor moving** (`Positioner`: the anchor policy `"close"`). A bubble ended
 *   by a scroll or a press does not start a group: the next text waits its turn. Only the bubble closes on the first
 *   Escape when it is the top overlay.
 * - **Keyboard focus** (WCAG 1.4.13): a trigger that takes the focus by keyboard shows its bubble at once and closes it on
 *   blur. nsh sends a focus event only to the view that takes it, and only to a view that takes presses: the wrapper
 *   `View` of `Tipped` never has it, and nsh's `Button` has no focus prop. A control built on a `View` with `onPress`
 *   spreads `useTriggerFocus()` to take part; a `Button` cannot.
 * - Not taken: waiting for the pointer to *rest* (`onMouseMove`: a JS turn per frame for every text the pointer crosses), a
 *   hoverable bubble and a safe polygon (a bubble holds no controls: `PreviewCard` is the popup the pointer can enter),
 *   following the cursor (`trackCursorAxis`), animation, an arrow (a 6 pt offset pill points at its anchor by proximity;
 *   Base UI and shadcn draw one because their bubbles are larger cards that sit further out).
 *
 * Each root view has its own host (`PopupRoot`): a dialog is its own root view, and an overlay is placed in the root of its anchor.
 */

/** How long the pointer rests on a trigger before the first bubble shows. */
export const REST_MS = 500;
/** While a bubble is open, or the pointer left one less than this long ago, the next one opens at once. */
export const GROUP_MS = 400;
const GAP = 6;
/** The room a bubble keeps from every edge of the window. */
const WINDOW_MARGIN = 8;
/** `max-w-60`: what a bubble is estimated at before it is measured (the widest it can be), so a trigger near an edge lines up with it. */
const BUBBLE_MAX = 240;
const BUBBLE_HEIGHT = 24;

/**
 * The shell of every bubble: a small inverted pill (the ink colour as the fill, the page colour as the text), so it reads
 * as a label laid over the window and never as a miniature popover. No border and no shadow: against either ground the
 * fill is 13:1 or more, so nothing has to lift it. Radius `md` 8 minus the 4 pt of vertical padding is `sm` 4, the radius
 * of the key chip inside (nested radii). 240 pt is about 40 characters at 12 pt: longer text wraps instead of stretching
 * the bubble across the window.
 */
const BUBBLE = "max-w-60 rounded-md bg-foreground px-2 py-1";

/** Text inside a bubble, in the page colour. Regular weight: light on dark already looks heavier than it is. */
export function TipText(props: { children?: JSX.Element }) {
  return <Text class="text-xs text-background">{props.children}</Text>;
}

/**
 * What `Tipped` shows: the label, and the shortcut as keycaps 8 pt after it in the same bubble. The caps are the page
 * colour at 80% on a chip of the page colour at 15%. They are decorative: the control's accessible name already carries the label.
 */
export function TipContent(props: { label: string; shortcut?: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <TipText>{props.label}</TipText>
      <If when={props.shortcut}>{(keys) => <Keys keys={keys()} tone="tip" />}</If>
    </View>
  );
}

/**
 * One bubble drawn in place, with the surface of the real one: for a lab or a spec page, because the host's window
 * screenshot does not draw the bubble's overlay. Not for screens: they wrap a control in `Tipped`.
 */
export function TipPreview(props: { children?: JSX.Element }) {
  return <View class={`self-start ${BUBBLE}`}>{props.children}</View>;
}

/** What one tooltip trigger asks for; every value is read when it is needed, so it may be a signal's. */
export interface TooltipOptions {
  /** No bubble while this is true: a bubble that shows is closed when it turns true. */
  disabled?: () => boolean;
  /** Milliseconds the pointer rests before this trigger's bubble shows, over the root's. */
  delay?: number;
  /** Milliseconds after the pointer left before the bubble closes, over the root's. */
  closeDelay?: number;
  /** A press on the trigger ends its bubble (default true). False keeps it, and a pending one. */
  closeOnClick?: boolean;
  /** Which side of the trigger the bubble prefers (default bottom). It goes to the other when this one lacks room: put it `top` where below is the next row. */
  side?: "top" | "bottom";
  /** How the bubble lines up with the trigger (default center); `start` or `end` when centred it would leave the window. */
  align?: "start" | "center" | "end";
}

/** The root's timing (Base UI's `Tooltip.Provider`). */
export interface TooltipTiming {
  delay?: number;
  closeDelay?: number;
  /** After a bubble closed by the pointer leaving, the next opens at once for this long. */
  timeout?: number;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
}

/** A trigger: the `say` it shows. */
export interface TipTrigger extends HoverTrigger {
  say: () => JSX.Element;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}

/** The state of one root view's tooltips. */
export function createTooltips(timing: TooltipTiming = {}): Hover<TipTrigger> {
  return createHover<TipTrigger>({
    state: createOpenState({ onOpenChange: timing.onOpenChange }),
    delay: timing.delay ?? REST_MS,
    closeDelay: timing.closeDelay ?? 0,
    group: timing.timeout ?? GROUP_MS,
    focusDelay: 0,
    hoverable: false,
  });
}

/** What `useTooltip` and `PreviewCard` give a control that can take the keyboard focus. */
export interface TriggerFocus {
  onFocus?: () => void;
  onBlur?: () => void;
}

export const Tooltips = context<Hover<TipTrigger> | undefined>(undefined);
export const FocusScope = context<TriggerFocus>({});

/**
 * The focus events of the nearest tooltip or preview-card trigger, for the control inside it that takes the keyboard focus:
 * `<View role="button" onPress={…} {...useTriggerFocus()}>`. Call it where the control is made.
 */
export function useTriggerFocus(): TriggerFocus {
  return FocusScope();
}

/** The bubble of a root view's tooltips. */
export function TooltipLayer(props: { hover: Hover<TipTrigger> }) {
  const { hover } = props;
  effect(() => hover.sync());
  // Where the shown trigger's bubble goes: worked out from the trigger's frame once it is measured (`undefined` meanwhile).
  const place = signal<BubblePlace | undefined>(undefined);
  effect(() => {
    const t = hover.open() ? hover.active() : null;
    place.set(undefined);
    const node = t?.node;
    if (!t || !node) return;
    void node.measure().then((m) => {
      if (!m || hover.active() !== t) return;
      const win = windowSize();
      place.set(
        placeBubble({
          anchor: { x: m.pagePosition.x, y: m.pagePosition.y, ...m.bounds.size },
          bubble: { width: BUBBLE_MAX, height: BUBBLE_HEIGHT },
          window: win,
          side: t.side,
          align: t.align,
          gap: GAP,
          margin: WINDOW_MARGIN,
        }),
      );
    });
  });
  return (
    <If when={hover.open() ? hover.active() : null}>
      {(t) => (
        <If when={place()}>
          {(at) => (
            <Positioner
              anchor={t().node}
              side={at().side}
              align={at().align}
              offset={GAP}
              margin={WINDOW_MARGIN}
              noPointer
              onCancel={hover.escape}
              onPosition={hover.placed}
              onAnchorMoved={hover.moved}
              style={{ maxWidth: at().width }}
              class={BUBBLE}
            >
              {t().say()}
            </Positioner>
          )}
        </If>
      )}
    </If>
  );
}

/** What `useTooltip` gives a trigger view. */
export interface TooltipProps {
  ref?: (node: ViewRef) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  focus: TriggerFocus;
}

/**
 * The props that make a view a tooltip trigger: `ref`, `onMouseEnter`, `onMouseLeave`, and `focus`, for the control inside it that
 * takes the keyboard focus (`FocusScope`). `say` builds what the bubble holds, and is read again while it shows. Call it
 * where the component is made, not later. Outside a `PopupRoot` the props are empty.
 */
export function useTooltip(say: () => JSX.Element, options: TooltipOptions = {}): TooltipProps {
  const hover = Tooltips();
  if (!hover) return { focus: {} };
  const trigger: TipTrigger = {
    node: undefined,
    say,
    disabled: options.disabled,
    delay: options.delay,
    closeDelay: options.closeDelay,
    closeOnClick: options.closeOnClick,
    side: options.side,
    align: options.align,
  };
  const events = hover.register(trigger);
  cleanup(events.gone);
  return {
    ref: (node: ViewRef) => {
      trigger.node = node;
    },
    onMouseEnter: events.enter,
    onMouseLeave: events.leave,
    // Built when asked for: a `Clipped` in a list never is.
    get focus() {
      return { onFocus: events.focus, onBlur: events.blur };
    },
  };
}
