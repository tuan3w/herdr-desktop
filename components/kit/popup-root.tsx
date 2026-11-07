import { cleanup, context, type JSX, signal, View } from "nsh";

import { CardLayer, Cards, createCards, type CardTiming } from "./preview-card";
import { createTooltips, TooltipLayer, Tooltips, type TooltipTiming } from "./tooltip";

import type { Followed } from "./hover";

/**
 * What a root view's hoverable popups register with, so that the root's hover move reaches them while one waits to close
 * (the safe zone between a trigger and its popup). A popup outside a `PopupRoot` has none and closes on its timers alone.
 */
export interface PathWatch {
  add: (hover: Followed) => () => void;
}

export const Paths = context<PathWatch | undefined>(undefined);

/**
 * The root of a surface's popups: a view that holds the one tooltip bubble and the one preview card of the surface, closes
 * them on any press, and follows the pointer for a hoverable popup that waits to close. Wrap the app, and the content of
 * every dialog (a dialog is a root view of its own). `tooltip` and `card` are the timings (`TooltipTiming`, `CardTiming`).
 */
export function PopupRoot(props: {
  class?: string;
  tooltip?: TooltipTiming;
  card?: CardTiming;
  children?: JSX.Element;
}) {
  const tips = createTooltips(props.tooltip);
  const cards = createCards(props.card);
  const watched = signal<Followed[]>([cards]);
  const paths: PathWatch = {
    add(hover) {
      watched.update((all) => [...all, hover]);
      return () => watched.update((all) => all.filter((h) => h !== hover));
    },
  };
  const waiting = () => watched().some((h) => h.tracking());
  cleanup(() => {
    tips.hide("none");
    cards.hide("none");
  });
  return (
    <Tooltips.Provider value={tips}>
      <Cards.Provider value={cards}>
        <Paths.Provider value={paths}>
          <View
            class={props.class}
            onTouchStartCapture={() => {
              tips.press();
              cards.press();
            }}
            onMouseMove={
              waiting()
                ? (e) => {
                    for (const h of watched()) h.track(e.pagePosition);
                  }
                : undefined
            }
          >
            {props.children}
            <TooltipLayer hover={tips} />
            <CardLayer hover={cards} />
          </View>
        </Paths.Provider>
      </Cards.Provider>
    </Tooltips.Provider>
  );
}
