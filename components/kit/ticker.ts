import { cleanup, effect, lifecycle, signal } from "nsh";

/** A step of every looping indicator: 8 a second, because each one is a frame the window draws. */
export const TICK_MS = 125;

const step = signal(0);
let holders = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function sync() {
  if (holders > 0 && timer === undefined) {
    timer = setInterval(() => step.update((n) => n + 1), TICK_MS);
  } else if (holders === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Whether the shared timer exists: false with no indicator on screen and while the window is in the background. */
export const tickerRunning = (): boolean => timer !== undefined;

/**
 * The step counter of every looping indicator, advanced by ONE timer shared by all. Call it while building the
 * indicator, read the returned function where it is drawn. The timer exists only while an indicator is mounted and
 * the window is not hidden or minimized.
 *
 * Why not a native loop (`iterations: "infinite"`): nsh issue 958, an endless native animation keeps the frame clock
 * at the screen's rate (60 to 120 fps) and, in the background, keeps the main thread ticking for ever. Measured: one
 * 16 pt spinner took a static window from 0 fps to 60 and added 3 to 4% CPU.
 */
export function useTicker(): () => number {
  let held = false;
  const release = () => {
    if (!held) return;
    held = false;
    holders -= 1;
    sync();
  };
  effect(() => {
    const hidden = lifecycle() === "background";
    release();
    if (hidden) return;
    held = true;
    holders += 1;
    sync();
  });
  cleanup(release);
  return () => step();
}
