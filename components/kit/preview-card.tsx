import { cleanup, context, effect, type JSX, View } from "nsh";

import type { Align, Placement, ViewRef } from "nsh/types";

import { EDGE } from "./core";
import { createHover, type Hover, type HoverTrigger } from "./hover";
import { createOpenState, type OpenChange } from "./popup";
import { Positioner } from "./positioner";
import { FocusScope } from "./tooltip";

/**
 * A hover card (Base UI's `PreviewCard`): what a link or a reference points at, shown beside it for a user with a pointer
 * (`design/overlays.md`). It is the popup the pointer may enter, which a tooltip is not, so it may hold text, a few lines of
 * facts and even a link; it is never the only place a fact lives, and screen readers are not told about it (Base UI: "for sighted users").
 *
 * - Opens after the pointer rests `delay` (600ms) on the trigger, or after the keyboard focus has been on it that long; closes
 *   `closeDelay` (300ms) after the pointer left both the trigger and the card.
 * - **Safe zone**: from the moment the pointer leaves the trigger the card stays while the pointer is in the triangle toward
 *   it and in the gap (`inSafeZone`), over the card, or for `closeDelay`. The pointer's path is the root view's hover move,
 *   fed to `track` only while a card waits to close (`PopupRoot`): nothing runs for a card that is closed or not waiting.
 * - Closes on any press (a press on the card itself does not end it), Escape, the anchor moving (`Positioner`), the trigger
 *   going away, a dialog opening above it.
 * - One card per root view, shared by all triggers: moving to another trigger while a card is open moves it.
 */

/** How long the pointer rests on the trigger before the card shows. */
export const CARD_DELAY_MS = 600;
/** How long after the pointer left before the card closes. */
export const CARD_CLOSE_MS = 300;
const GAP = 6;
const CARD = `max-w-sm rounded-lg bg-popover p-3 text-popover-foreground ${EDGE.md}`;

/** A trigger: what its card holds and where it goes. */
export interface CardTrigger extends HoverTrigger {
  card: () => JSX.Element;
  label: () => string | undefined;
  side: () => Placement | undefined;
  align: () => Align | undefined;
}

export interface CardTiming {
  delay?: number;
  closeDelay?: number;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
}

/** The state of one root view's preview card. */
export function createCards(timing: CardTiming = {}): Hover<CardTrigger> {
  const delay = timing.delay ?? CARD_DELAY_MS;
  return createHover<CardTrigger>({
    state: createOpenState({ onOpenChange: timing.onOpenChange }),
    delay,
    closeDelay: timing.closeDelay ?? CARD_CLOSE_MS,
    group: 0,
    focusDelay: delay,
    hoverable: true,
  });
}

export const Cards = context<Hover<CardTrigger> | undefined>(undefined);

/** The card of a root view. */
export function CardLayer(props: { hover: Hover<CardTrigger> }) {
  const { hover } = props;
  effect(() => hover.sync());
  return (
    <If when={hover.open() ? hover.active() : null}>
      {(t) => (
        <Positioner
          anchor={t().node}
          side={t().side() ?? "bottom"}
          align={t().align() ?? "start"}
          offset={GAP}
          label={t().label()}
          onCancel={hover.escape}
          onPosition={hover.placed}
          onAnchorMoved={hover.moved}
          onMouseEnter={hover.popupEnter}
          onMouseLeave={hover.popupLeave}
          class={CARD}
        >
          {t().card()}
        </Positioner>
      )}
    </If>
  );
}

/** A preview card drawn in place, with the surface of the real one: for a lab or a spec page (the host's screenshot draws no overlay). */
export function CardPreview(props: { children?: JSX.Element }) {
  return <View class={`self-start ${CARD}`}>{props.children}</View>;
}

/**
 * Wraps the thing the card is about (a reference, a name) in its trigger; `card` builds what the card holds, each time it
 * opens. `disabled` stops it; `side` and `align` place it (below, aligned to the start, by default). Layout classes for the
 * wrapper go in `class`. A control inside that takes the keyboard focus through a `View` with `onPress` spreads
 * `useTriggerFocus()`: the card then opens for keyboard users too. Outside a `PopupRoot` it is a plain wrapper.
 */
export function PreviewCard(props: {
  card: () => JSX.Element;
  label?: string;
  disabled?: boolean;
  delay?: number;
  closeDelay?: number;
  side?: Placement;
  align?: Align;
  class?: string;
  children?: JSX.Element;
}) {
  const hover = Cards();
  const trigger: CardTrigger = {
    node: undefined,
    card: props.card,
    label: () => props.label,
    side: () => props.side,
    align: () => props.align,
    disabled: () => props.disabled ?? false,
    get delay() {
      return props.delay;
    },
    get closeDelay() {
      return props.closeDelay;
    },
  };
  const events = hover?.register(trigger);
  if (events) cleanup(events.gone);
  return (
    <View
      ref={(node: ViewRef) => {
        trigger.node = node;
      }}
      onMouseEnter={events?.enter}
      onMouseLeave={events?.leave}
      class={props.class}
    >
      <FocusScope.Provider value={events ? { onFocus: events.focus, onBlur: events.blur } : {}}>
        {props.children}
      </FocusScope.Provider>
    </View>
  );
}
