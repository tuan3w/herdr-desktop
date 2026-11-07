import { Animated, createMotion, effect, type Easing, reduceMotion } from "nsh";
import type { ViewStyle } from "nsh/types";

/** Milliseconds. Exits run ~25% faster than enters. */
export const DURATION = { press: 120, hover: 150, pop: 160, enter: 220, exit: 160 } as const;
/** Strong ease-out for anything entering or pressing. */
export const EASE_OUT: Easing = [0.32, 0.72, 0, 1];
/** Scale of a depressed control: below 0.95 it looks exaggerated. */
export const PRESS_SCALE = 0.96;
/** Scale a dialog popup starts from: never from 0. */
export const ENTER_SCALE = 0.97;

const PRESS: ViewStyle = { transitionProperty: "colors", transitionDuration: DURATION.press, transitionTimingFunction: "ease-out" };
const HOVER: ViewStyle = { transitionProperty: "colors", transitionDuration: DURATION.hover, transitionTimingFunction: "ease-out" };

/** `style` of a `Btn`: its press and hover color changes ease. None when the user asks for less motion. */
export const pressTransition = (): ViewStyle | undefined => (reduceMotion() ? undefined : PRESS);
/** `style` of a hover-only row, tab or trigger: color changes ease. */
export const hoverTransition = (): ViewStyle | undefined => (reduceMotion() ? undefined : HOVER);

const MOVE: ViewStyle = { transitionProperty: "transform", transitionDuration: DURATION.pop, transitionTimingFunction: "ease-out" };
/** `style` of a part that slides (the switch thumb): `transform` eases. None under reduced motion. */
export const moveTransition = (): ViewStyle | undefined => (reduceMotion() ? undefined : MOVE);

/**
 * Depress feedback for one pressable. Spread `style` onto the `Button`, call `down` from `onPressDown` and `up`
 * from `onPressUp`. It animates the motion's `scale` from wherever it is, so releasing mid-press glides back
 * instead of snapping. Does nothing when the user asks for less motion.
 * (`Button`'s `activeStyle` transform is not applied by the macOS host, so the scale is driven here.)
 */
export function pressFeedback() {
  const motion = createMotion();
  const to = (scale: number) => {
    if (reduceMotion()) return;
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
    if (open()) void motion.play({ keyframes: { scale: [ENTER_SCALE, 1] }, duration: DURATION.enter, easing: EASE_OUT });
  });
  return motion.style;
}
