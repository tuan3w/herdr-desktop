import {
  Animated,
  type AnimatedValue,
  cleanup,
  createMotion,
  effect,
  type Easing,
  LayoutAnimation,
  type MotionSpec,
  reduceMotion,
  signal,
  untracked,
} from "nsh";

import type { Align, Placement, ViewStyle } from "nsh/types";

import { reduceMotionOverride } from "#lib/settings";

/**
 * Less motion is wanted: the system asks for it, or the person set Settings > Reduce motion. Every motion in the app
 * reads this, never `reduceMotion()`. Limit: nsh applies the system setting itself to `motion-reduce:` classes, to its
 * own `Dialog` fade and to a `createMotion` `enter`; the app's setting cannot reach those, so a dialog still fades and
 * the check mark of a `CheckRow` still pops in when only the app's setting is on.
 */
export const reducedMotion = (): boolean => reduceMotion() || reduceMotionOverride();

/**
 * Milliseconds, by purpose. Nothing is longer than 240 and an exit is about a quarter quicker than its enter: the person
 * has already decided to leave, so the exit must not make them wait. The one exception is the dialog (`dialog`, below).
 */
export const DURATION = {
  /** A press: feedback has to feel instant (emil: 100-150). */
  press: 100,
  /** A hover or selected fill: a colour only, never in the way of the pointer. */
  hover: 120,
  /** A changed number: long enough to see which figure moved, short enough for a ticking count. */
  swap: 140,
  /** A glyph, a check mark, a thumb or a chevron: a small part moving a short way. */
  pop: 160,
  /** A popover enters. */
  popup: 160,
  /** A popover or the pill leaves: 25% under `popup`. */
  popupExit: 120,
  /**
   * A dialog's popup enters and leaves. nsh fades the dialog's layer and scrim for a fixed 200 ms (`FADE`,
   * nsh-core `navigation.rs`) with no prop to change it, so the popup keeps the same 200 both ways: a scale that ends
   * before its scrim reads as two things. This is the one exit that is not quicker.
   */
  dialog: 200,
  /** A toast enters. */
  toast: 200,
  /** A toast leaves. */
  toastExit: 150,
  /** A layout animation (a fold, the inbox, an answer arriving). */
  fold: 200,
  /** A thing arrives (a card, a row, a line, a pill). */
  rise: 200,
  /** The quick fade of what is opened many times a day: the palette, a project switch, a tab's face. */
  context: 120,
} as const;

const OUT_CURVE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const MOVE_CURVE: [number, number, number, number] = [0.77, 0, 0.175, 1];
const IN_CURVE: [number, number, number, number] = [0.4, 0, 1, 1];
/** Strong ease-out for what enters or is pressed: the start is fast, so the answer to the person's action is at once. */
export const EASE_OUT: Easing = OUT_CURVE;
/** Ease-in-out for what is already on screen and moves (a knob, a chevron): it accelerates and brakes like a thing with mass. */
export const EASE_MOVE: Easing = MOVE_CURVE;
/** Ease-in for exits only: it starts slow, which is wrong for an answer and right for a thing leaving. */
export const EASE_IN: Easing = IN_CURVE;
/** nsh's style transitions take a `cubic-bezier(...)` string (`timing_function`, nsh-core `style.rs`), no spaces after commas. */
const bezier = (c: readonly number[]) => `cubic-bezier(${c.join(",")})` as `cubic-bezier(${string})`;

/** Scale of a depressed control: below 0.95 it looks exaggerated. */
export const PRESS_SCALE = 0.96;
/** Scale a popover starts from (and returns to on its way out): never from 0. */
export const POPOVER_SCALE = 0.96;
/** Scale a dialog popup starts from: bigger things move less. */
export const DIALOG_SCALE = 0.97;
/** Scale the command palette starts from. */
const PALETTE_SCALE = 0.98;

const transition = (property: string, ms: number, curve: readonly number[]): ViewStyle => ({
  transitionProperty: property,
  transitionDuration: ms,
  transitionTimingFunction: bezier(curve),
});
const PRESS = transition("colors", DURATION.press, OUT_CURVE);
const HOVER = transition("colors", DURATION.hover, OUT_CURVE);

/** `style` of a `Btn`: its press and hover color changes ease. None when the user asks for less motion. */
export const pressTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : PRESS);
/** `style` of a hover-only row, tab or trigger: color changes ease. */
export const hoverTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : HOVER);

const MOVE = transition("transform", DURATION.pop, MOVE_CURVE);
const TRACK = transition("colors", DURATION.pop, MOVE_CURVE);
/** `style` of a part that slides or turns (the switch knob, a chevron): `transform` eases. None under reduced motion. */
export const moveTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : MOVE);
/** `style` of what changes colour with a moving part (the switch track): same duration and curve as `moveTransition`. */
export const trackTransition = (): ViewStyle | undefined => (reducedMotion() ? undefined : TRACK);

/**
 * Time and timers of this file, in one place so a test can replace them: no motion rule is tested against the real clock.
 */
export const motionClock = {
  now: (): number => Date.now(),
  /** Runs `run` after `ms`; returns what cancels it. */
  after(ms: number, run: () => void): () => void {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
};

/** A key pressed this recently makes what follows a keyboard action: it does not animate (emil: never on a shortcut). */
export const KEY_WINDOW_MS = 250;
let lastKey = Number.NEGATIVE_INFINITY;
/** Called by the app's global shortcut handler before the action runs (`App.tsx`). */
export function markKeyboard(): void {
  lastKey = motionClock.now();
}
const keyboardRecent = (): boolean => motionClock.now() - lastKey < KEY_WINDOW_MS;

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

/** How a popup looks at its start and, run backwards, at its end: the channels that move, and how long each way takes. */
export interface PresenceLook {
  /** Opacity goes 0 to 1 (default true). A dialog's popup does not: nsh fades its whole layer. */
  fade?: boolean;
  /** Scale it starts from and leaves to. */
  scale?: number;
  /** Points it starts below its place and leaves to. */
  rise?: number;
  enter: number;
  exit: number;
}

/**
 * The motion of a thing that comes and goes: `show` runs it in to rest, `hide` runs it out, both from wherever the values
 * are, so a `show` in the middle of a `hide` turns around instead of jumping (an `AnimatedValue` retargets; a keyframe
 * restarts). Enters ease out, exits ease in, reduced motion snaps. Values rest at the start look while hidden, so the
 * first frame of the next `show` is already right. Bind `style` to the thing.
 */
export function presenceMotion(look: PresenceLook) {
  const fade = look.fade ?? true;
  const motion = createMotion({
    initial: {
      ...(fade ? { opacity: 0 } : {}),
      ...(look.scale === undefined ? {} : { scale: look.scale }),
      ...(look.rise === undefined ? {} : { translateY: look.rise }),
    },
  });
  // Shown, or on its way out: only a `hide` that ran to its end makes the next `show` start from the start look again.
  let live = false;
  const channels = (): [AnimatedValue, number, number][] => {
    const all: [AnimatedValue, number, number][] = [];
    if (fade) all.push([motion.opacity, 1, 0]);
    if (look.scale !== undefined) all.push([motion.scale, 1, look.scale]);
    if (look.rise !== undefined) all.push([motion.translateY, 0, look.rise]);
    return all;
  };
  const snap = (rest: boolean) => {
    for (const [value, at, from] of channels()) value.set(rest ? at : from);
  };
  const run = (rest: boolean, duration: number, easing: Easing) =>
    Promise.all(channels().map(([value, at, from]) => value.timing(rest ? at : from, { duration, easing }))).then(
      (results) => results.every((r) => r.finished),
    );
  return {
    style: motion.style,
    /** `snap`: it is there from the start (built open), so it does not arrive. */
    show(now = false) {
      if (!live) snap(false);
      live = true;
      if (now || reducedMotion()) snap(true);
      else void run(true, look.enter, EASE_OUT);
    },
    hide() {
      if (reducedMotion()) {
        snap(false);
        live = false;
        return;
      }
      void run(false, look.exit, EASE_IN).then((finished) => {
        if (finished) live = false;
      });
    },
  };
}

/**
 * Whether a thing is built: open, or on its way out. Closing keeps it built for `exitMs` so its exit can play, then
 * unbuilds it; opening again in that time cancels the unbuilding. No exit (and no wait) under reduced motion or when
 * `exitMs` is 0. Pure state: the timer is `motionClock.after`, the animation is the caller's (`presenceMotion`).
 */
export function createPresence(open: boolean, exitMs: number) {
  const mounted = signal(open);
  const closing = signal(false);
  let cancel: (() => void) | undefined;
  const stop = () => {
    cancel?.();
    cancel = undefined;
  };
  return {
    mounted,
    /** Mounted only to play its exit: it takes no presses. */
    closing,
    /** Follows the thing's open state. */
    set(next: boolean) {
      stop();
      if (next) {
        closing.set(false);
        mounted.set(true);
        return;
      }
      if (!untracked(mounted)) return;
      if (exitMs <= 0 || reducedMotion()) {
        closing.set(false);
        mounted.set(false);
        return;
      }
      closing.set(true);
      cancel = motionClock.after(exitMs, () => {
        cancel = undefined;
        closing.set(false);
        mounted.set(false);
      });
    },
    stop,
  };
}

/**
 * A popup that stays built through its exit: `mounted()` is what to put in `<If when>`, `closing()` makes it take no
 * presses, `style` is its motion. Built open, it is there at once. Only popovers and the like (occasional, pointer
 * opened) use it: a menu, a select, a tooltip and the palette open and close at once because they are used many times a
 * day (`design/motion.md`).
 */
export function popupPresence(open: () => boolean, look: PresenceLook) {
  const motion = presenceMotion(look);
  const presence = createPresence(untracked(open), look.exit);
  let first = true;
  effect(() => {
    const now = open();
    untracked(() => {
      presence.set(now);
      if (now) motion.show(first);
      else if (!first) motion.hide();
      first = false;
    });
  });
  cleanup(presence.stop);
  return { mounted: presence.mounted, closing: presence.closing, style: motion.style };
}

/** The look of a popover: fade and scale from the trigger. */
export const POPOVER_LOOK: PresenceLook = { scale: POPOVER_SCALE, enter: DURATION.popup, exit: DURATION.popupExit };

/**
 * Where a popover's scale starts: the edge that touches its trigger, lined up by `align`. `placement` is where the popup
 * was put (it can differ from the side asked for when it did not fit), so a flipped popover grows from the right edge.
 */
export function popupOrigin(placement: Placement, align: Align): string {
  const along = align === "start" ? "0%" : align === "end" ? "100%" : "50%";
  if (placement === "bottom") return `${along} 0%`;
  if (placement === "top") return `${along} 100%`;
  if (placement === "right") return `0% ${along}`;
  return `100% ${along}`;
}

/**
 * The dialog popup: scales from `DIALOG_SCALE` to 1 each time `open()` turns true and back when it turns false, over
 * `DURATION.dialog`, both ways, as long as nsh's layer fade it sits in. Only the scale: the fade of the layer, scrim
 * and popup together is nsh's. Bind the returned style to the popup; the origin stays the centre.
 */
export function enterScale(open: () => boolean) {
  const motion = presenceMotion({ fade: false, scale: DIALOG_SCALE, enter: DURATION.dialog, exit: DURATION.dialog });
  let was = false;
  effect(() => {
    const now = open();
    untracked(() => {
      if (now !== was) {
        if (now) motion.show();
        else motion.hide();
      }
      was = now;
    });
  });
  return motion.style;
}

/**
 * The command palette opening: it fades in and scales from 0.98 in `DURATION.context` (120 ms), shorter than a dialog's
 * entrance because it opens many times a day. Closing is instant. Nothing under reduced motion.
 */
export function paletteEnter(open: () => boolean) {
  const motion = createMotion();
  effect(() => {
    if (open() && !reducedMotion())
      void motion.play({
        keyframes: { opacity: [0, 1], scale: [PALETTE_SCALE, 1] },
        duration: DURATION.context,
        easing: EASE_OUT,
      });
  });
  return motion.style;
}

/**
 * What nsh's `Toast` takes to enter and leave: it has no look of its own. It enters from 12 pt below with a fade
 * (`DURATION.toast`, ease-out) and leaves with a fade and a small shrink (`DURATION.toastExit`, ease-in; the store keeps
 * it built that long, `exitMs`). `swipingClass` stops the transition while a pointer drags it: it follows 1:1. Nothing
 * under reduced motion (nsh applies only the system setting itself).
 */
export function toastLook(): { class?: string; startingClass?: string; endingClass?: string; swipingClass?: string } {
  if (reducedMotion()) return {};
  return {
    class: `transition-[opacity,transform] duration-[${DURATION.toast}ms] ease-[${bezier(OUT_CURVE)}]`,
    startingClass: "opacity-0 translate-y-3",
    endingClass: `opacity-0 scale-[0.97] duration-[${DURATION.toastExit}ms] ease-[${bezier(IN_CURVE)}]`,
    swipingClass: "transition-none",
  };
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
 * Whether the thing built now is an arrival: the first time its `key` is built after the app's first screen, not under
 * reduced motion and not while a key was just pressed (a shortcut's result does not animate). Remembers the key either
 * way, so a screen built again after a tab switch is never one. Without a key it is an arrival each time it is asked.
 */
export function arrived(key?: string): boolean {
  const first = key === undefined || !shown.has(key);
  if (key !== undefined) shown.add(key);
  return first && !reducedMotion() && untracked(motionReady) && !keyboardRecent();
}

const FADE_IN: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: DURATION.context, easing: EASE_OUT };

/**
 * `style` of a thing that has just arrived (a project card, an agent's row, a tab's face), when `arrived(key)`: it fades in
 * and rises 8 pt (`kind` "rise", `DURATION.rise`), or only fades in over `DURATION.context` (`"fade"`, for what a person
 * makes often: a tab). `undefined` (it just is there) otherwise. Call it while the thing is being built; a thing that
 * is recycled by a virtual list uses `arrivals` instead.
 */
export function appear(key?: string, kind: "rise" | "fade" = "rise") {
  if (!arrived(key)) return undefined;
  const motion = createMotion({ initial: kind === "rise" ? { opacity: 0, translateY: RISE } : { opacity: 0 } });
  void motion.play(kind === "rise" ? RISE_IN : FADE_IN);
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

export const SETTLE_MS = 500;

export function arrivals(): Arrivals {
  const seen = new Set<string>();
  let settled = false;
  // One timer per list, once: it needs no owner, so the cell that happened to ask first may go without stopping it.
  motionClock.after(SETTLE_MS, () => (settled = true));
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

/** Changes closer together than this are a ticking count: only the first, after a quiet moment, is shown. */
export const SWAP_QUIET_MS = 1000;

/**
 * A short appearance for a number or a word that changed: it fades in from 0.6 and rises 4 pt, `DURATION.swap`. Returns
 * the `style` and `changed()`, which a component calls when its value changes (not for its first value) and which says
 * whether it played: not when the value changed again within `SWAP_QUIET_MS` (a status-bar figure that ticks would
 * flash all the time) and not under reduced motion.
 */
export function swapped() {
  const motion = createMotion();
  let last = Number.NEGATIVE_INFINITY;
  return {
    style: motion.style,
    changed(): boolean {
      const now = motionClock.now();
      const quiet = now - last >= SWAP_QUIET_MS;
      last = now;
      if (!quiet || reducedMotion()) return false;
      void motion.play({
        keyframes: { opacity: [0.6, 1], translateY: [4, 0] },
        duration: DURATION.swap,
        easing: EASE_OUT,
      });
      return true;
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
 * when it starts, so it never delays a key. `play` does nothing (and says false) under reduced motion, while switches
 * repeat and when a key caused the switch (`markKeyboard`: a shortcut never animates). It moves the area's wrapper, never
 * a pane's rows. Bind `style` to that wrapper.
 */
export function contextEnter() {
  const motion = createMotion();
  let last = Number.NEGATIVE_INFINITY;
  return {
    style: motion.style,
    play(): boolean {
      const now = motionClock.now();
      const repeated = now - last < CONTEXT_REPEAT_MS;
      last = now;
      if (reducedMotion() || repeated || keyboardRecent()) {
        motion.reset();
        return false;
      }
      void motion.play({ keyframes: { opacity: [CONTEXT_FROM, 1] }, duration: DURATION.context, easing: EASE_OUT });
      return true;
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

/** The look of the "Jump to latest" pill: it rises in and sinks out. */
const PILL_LOOK: PresenceLook = { rise: RISE, enter: DURATION.rise, exit: DURATION.popupExit };

/**
 * A value that shows and goes with a short exit (the pill: `null` is gone). `value()` is the last non-null value until
 * the exit has played, for `<If when>`; bind `style` to the element it builds.
 */
export function leaving<T>(value: () => T | null) {
  let last: T | null = null;
  const held = popupPresence(() => value() !== null, PILL_LOOK);
  return {
    value: (): T | null => {
      const now = value();
      if (now !== null) last = now;
      return held.mounted() ? last : null;
    },
    style: held.style,
  };
}
