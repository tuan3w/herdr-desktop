import {
  Animated,
  createMotion,
  effect,
  type Easing,
  LayoutAnimation,
  type MotionSpec,
  reduceMotion,
  signal,
  untracked,
} from "nsh";

import type { ViewStyle } from "nsh/types";

import { reduceMotionOverride } from "#lib/settings";

/**
 * Less motion is wanted: the system asks for it, or the person set Settings > Reduce motion. Every motion in the app
 * reads this, never `reduceMotion()`. Limit: nsh applies the system setting itself to `motion-reduce:` classes, to its
 * own `Dialog` fade and to a `createMotion` `enter`; the app's setting cannot reach those, so a dialog still fades and
 * the check mark of a `CheckRow` still pops in when only the app's setting is on.
 */
export const reducedMotion = (): boolean => reduceMotion() || reduceMotionOverride();

/** Milliseconds, by purpose. Exits run about 25% faster than enters. */
export const DURATION = {
  press: 120,
  hover: 150,
  pop: 160,
  swap: 160,
  enter: 220,
  exit: 160,
  fold: 220,
  rise: 240,
  context: 120,
} as const;
/** Strong ease-out for anything entering or pressing. */
export const EASE_OUT: Easing = [0.32, 0.72, 0, 1];
/** Scale of a depressed control: below 0.95 it looks exaggerated. */
export const PRESS_SCALE = 0.96;
/** Scale a dialog popup starts from: never from 0. */
export const ENTER_SCALE = 0.97;

const PRESS: ViewStyle = {
  transitionProperty: "colors",
  transitionDuration: DURATION.press,
  transitionTimingFunction: "ease-out",
};
const HOVER: ViewStyle = {
  transitionProperty: "colors",
  transitionDuration: DURATION.hover,
  transitionTimingFunction: "ease-out",
};

/** `style` of a `Btn`: its press and hover color changes ease. None when the user asks for less motion. */
export const pressTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : PRESS);
/** `style` of a hover-only row, tab or trigger: color changes ease. */
export const hoverTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : HOVER);

const MOVE: ViewStyle = {
  transitionProperty: "transform",
  transitionDuration: DURATION.pop,
  transitionTimingFunction: "ease-out",
};
/** `style` of a part that slides (the switch thumb): `transform` eases. None under reduced motion. */
export const moveTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : MOVE);

/**
 * Depress feedback for one pressable. Spread `style` onto the `Button`, call `down` from `onPressDown` and `up`
 * from `onPressUp`. It animates the motion's `scale` from wherever it is, so releasing mid-press glides back
 * instead of snapping. Does nothing when the user asks for less motion.
 * (`Button`'s `activeStyle` transform is not applied by the macOS host, so the scale is driven here.)
 */
export function pressFeedback() {
  const motion = createMotion();
  const to = (scale: number) => {
    if (reducedMotion()) return;
    Animated.timing(motion.scale, { toValue: scale, duration: DURATION.press, easing: EASE_OUT }).start();
  };
  return { style: motion.style, down: () => to(PRESS_SCALE), up: () => to(1) };
}

/**
 * Entrance for a popup: scales from `ENTER_SCALE` to 1 each time `open()` turns true. Bind the returned style to
 * the popup. `createMotion` lands on the end state without moving when the user asks for less motion.
 */
export function enterScale(open: () => boolean) {
  const motion = createMotion();
  effect(() => {
    if (open() && !reducedMotion())
      void motion.play({ keyframes: { scale: [ENTER_SCALE, 1] }, duration: DURATION.enter, easing: EASE_OUT });
  });
  return motion.style;
}

/**
 * Set a moment after the first screen of the app is up. What is on screen when the window opens does not move: only what
 * arrives afterwards (a card, a message, a tab, the inbox) does, so opening the app is never a show.
 */
export const motionReady = signal(false);

/** Points a thing rises as it arrives, and the channels of that arrival: fade in and rise 8 pt, `DURATION.rise`, `EASE_OUT`. */
export const RISE = 8;
const RISE_IN: MotionSpec = {
  keyframes: { opacity: [0, 1], translateY: [RISE, 0] },
  duration: DURATION.rise,
  easing: EASE_OUT,
};

/** What has been on screen already, by key: a screen that is built again (a tab switched back to) is not an arrival. */
const shown = new Set<string>();

/**
 * `style` of a thing that has just arrived (a project card, an agent's row, a tab's face): it fades in and rises 8 pt the
 * first time `key` is built after the app's first screen. `undefined` (it just is there) for a key seen before (the home
 * built again after a tab switch is not a show), while the app is starting and under reduced motion. Without a key (a pill
 * that comes and goes) it plays every time it is built. Call it while the thing is being built; a thing that is recycled
 * by a virtual list uses `arrivals` instead.
 */
export function appear(key?: string) {
  const first = key === undefined || !shown.has(key);
  if (key !== undefined) shown.add(key);
  if (!first || reducedMotion() || !untracked(motionReady)) return undefined;
  const motion = createMotion({ initial: { opacity: 0, translateY: RISE } });
  void motion.play(RISE_IN);
  return motion.style;
}

/**
 * Which lines of a virtual list are new. Its cells are recycled, so building a cell says nothing about arrival: a line
 * arrives when its key is seen for the first time after the list had its first look. `settled` starts after a quiet
 * moment, so the lines a conversation opens with do not move. Scrolling back to a line already seen never moves it.
 */
export interface Arrivals {
  /** True once for a key seen for the first time after the list settled. */
  isNew(key: string): boolean;
}

export function arrivals(): Arrivals {
  const seen = new Set<string>();
  let settled = false;
  // One timer per list, once: it needs no owner, so the cell that happened to ask first may go without stopping it.
  setTimeout(() => (settled = true), 500);
  return {
    isNew(key: string): boolean {
      if (seen.has(key)) return false;
      seen.add(key);
      return settled;
    },
  };
}

/**
 * The `style` of one line of a virtual list, and what drives it: `arrive(key)` when the cell shows a line, which plays
 * the arrival if `isNew`. Animates the content, never the cell, so the list's recycling is not fought.
 */
export function arriving(isNew: (key: string) => boolean) {
  const motion = createMotion();
  return {
    style: motion.style,
    show(key: string) {
      if (isNew(key) && !reducedMotion()) void motion.play(RISE_IN);
      else motion.reset();
    },
  };
}

/**
 * A short appearance for a number or a word that changed: it fades in and rises 4 pt, `DURATION.swap`. Returns the
 * `style` and `changed()`, which a component calls when its value changes (not for its first value).
 */
export function swapped() {
  const motion = createMotion();
  return {
    style: motion.style,
    changed() {
      if (!reducedMotion())
        void motion.play({
          keyframes: { opacity: [0.2, 1], translateY: [4, 0] },
          duration: DURATION.swap,
          easing: EASE_OUT,
        });
    },
  };
}

/**
 * The state glyph of an agent has changed: it grows back from 0.5 with a fade, `DURATION.pop`. Not an endless turn for a
 * working agent: a loop keeps the app drawing every frame for as long as any agent works, and an app at rest draws none.
 */
export function glyphChanged() {
  const motion = createMotion();
  return {
    style: motion.style,
    changed() {
      if (!reducedMotion())
        void motion.play({
          keyframes: { opacity: [0.2, 1], scale: [0.5, 1] },
          duration: DURATION.pop,
          easing: EASE_OUT,
        });
    },
  };
}

/** Opacity a project's workspace starts from when it is shown in place of another: a hint of arrival, never a dip to nothing. */
export const CONTEXT_FROM = 0.88;
/** Two switches closer than this are one gesture (a key held): the second does not replay the entrance. */
export const CONTEXT_REPEAT_MS = 400;

/**
 * The entrance of a project's workspace when the person switches project: the incoming tabs fade from `CONTEXT_FROM`
 * to 1 in `DURATION.context`. Only the incoming side moves and nothing waits for it: the outgoing tabs are already gone
 * when it starts, so it never delays a key. `play` does nothing under reduced motion and while keys repeat. It moves the
 * area's wrapper, never a pane's rows. Bind `style` to that wrapper.
 */
export function contextEnter() {
  const motion = createMotion();
  let last = Number.NEGATIVE_INFINITY;
  return {
    style: motion.style,
    play() {
      const now = Date.now();
      const repeated = now - last < CONTEXT_REPEAT_MS;
      last = now;
      if (reducedMotion() || repeated) {
        motion.reset();
        return;
      }
      void motion.play({ keyframes: { opacity: [CONTEXT_FROM, 1] }, duration: DURATION.context, easing: EASE_OUT });
    },
  };
}

/** The next commit's changes animate: what was inserted fades in, what moved glides, what was removed fades out, over `DURATION.fold`. Under reduced motion nothing is configured. */
export function animateLayout(): void {
  if (reducedMotion()) return;
  LayoutAnimation.configureNext({
    duration: DURATION.fold,
    create: { type: "easeOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeIn", property: "opacity" },
  });
}

/**
 * Entrance of a popover's popup: it fades in, scales from `ENTER_SCALE` and slides 4 pt away from its trigger (`side` is
 * the side of the trigger it opens on), `DURATION.enter`, `EASE_OUT`. A menu or a list never calls this: they open at once.
 */
export function popupEnter(side: "top" | "bottom" | "left" | "right") {
  if (reducedMotion()) return undefined;
  const from = { top: [0, 4], bottom: [0, -4], left: [4, 0], right: [-4, 0] }[side];
  const motion = createMotion({
    initial: { opacity: 0, scale: ENTER_SCALE, translateX: from[0], translateY: from[1] },
  });
  void motion.play({
    keyframes: { opacity: [0, 1], scale: [ENTER_SCALE, 1], translateX: [from[0], 0], translateY: [from[1], 0] },
    duration: DURATION.enter,
    easing: EASE_OUT,
  });
  return motion.style;
}
