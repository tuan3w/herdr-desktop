import { fitScale, ZOOM_MAX, ZOOM_MIN } from "#lib/image-view";
import type { Pan, Size, Turn } from "#lib/image-view";

/**
 * The rules of the lightbox, apart from the screen: how the picture is fitted, the line that names it, where Left and
 * Right go, how a wheel becomes zoom steps and when the chrome rests. The zoom steps, the pan limits and the turn are
 * `lib/image-view.ts`, unchanged.
 */

/** The share of the window left empty on each side of a fitted picture. */
export const MARGIN = 0.08;
/** Controls fade out after this long without a pointer move; the zoom readout after `READOUT_MS` without a zoom. */
export const CHROME_MS = 2000;
export const READOUT_MS = 1200;

/** The room a fitted picture has: the window less the margin on every side. */
export const stage = (box: Size): Size => ({
  width: box.width * (1 - 2 * MARGIN),
  height: box.height * (1 - 2 * MARGIN),
});

/** The scale at which the picture fits `stage(box)`; like the old viewer's fit it is never above 1. */
export const lightboxFit = (natural: Size, turn: Turn | 0, box: Size): number =>
  fitScale(natural, turn as Turn, stage(box));

/** `shot-2.png · 2 of 5`; the position only when the folder has another picture. */
export function nameLine(name: string, names: readonly string[] | undefined): string {
  const at = names?.indexOf(name) ?? -1;
  return names && names.length > 1 && at >= 0 ? `${name} · ${at + 1} of ${names.length}` : name;
}

/** The picture a step from `current` reaches, or `undefined` at either end of the folder (the viewer stops, it does not wrap). */
export function stepTarget(names: readonly string[], current: string, step: -1 | 1): string | undefined {
  const at = names.indexOf(current);
  return at < 0 ? undefined : names[at + step];
}

/** More than this in one event is the sensor settling after a layout change, not the person's hand. */
const WHEEL_JUMP = 1200;
/** Wheel travel (points) that multiplies the scale by e: one notch of a mouse (about 30 points) is about 13%. */
export const WHEEL_RATE = 240;

/**
 * The scale after `delta` points of wheel travel (positive: in): continuous, so a trackpad zooms as smoothly as it scrolls,
 * and clamped to the zoom range. A jump the sensor makes when it settles changes nothing.
 */
export function wheelZoom(scale: number, delta: number): number {
  if (Math.abs(delta) > WHEEL_JUMP) return scale;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * Math.exp(delta / WHEEL_RATE)));
}

/** The pan that keeps the point `at` (from the box's centre) still on screen while the scale goes from `from` to `to`. */
export function zoomAt(pan: Pan, at: Pan, from: number, to: number): Pan {
  const k = from > 0 ? to / from : 1;
  return { x: at.x - (at.x - pan.x) * k, y: at.y - (at.y - pan.y) * k };
}

/** Where the lightbox's timers come from, so a test never waits on a clock. */
export interface IdleClock {
  /** Runs `run` after `ms`; returns what cancels it. */
  after: (ms: number, run: () => void) => () => void;
}

/**
 * "Active until `ms` of stillness": `poke()` makes it active and starts the wait again; once the wait ends `onChange(false)`
 * is told. `hold(true)` keeps it active (a menu is open) until `hold(false)`, which starts the wait. Used for the chrome
 * (2 s) and for the zoom readout (1.2 s): a finite fade, never a loop.
 */
export function createIdle(ms: number, clock: IdleClock, onChange: (active: boolean) => void) {
  let active = false;
  let held = false;
  let cancel: (() => void) | null = null;
  const set = (next: boolean) => {
    if (active === next) return;
    active = next;
    onChange(next);
  };
  const wait = () => {
    cancel?.();
    cancel = held
      ? null
      : clock.after(ms, () => {
          cancel = null;
          set(false);
        });
  };
  return {
    poke() {
      set(true);
      wait();
    },
    hold(on: boolean) {
      held = on;
      if (on) set(true);
      wait();
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}
