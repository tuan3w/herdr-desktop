import { View } from "nsh";

import { reducedMotion, turnClass } from "#lib/motion";

import { Icon, type IconTone } from "./icon";
import { useTicker } from "./ticker";

/**
 * Work is in progress and there is no way to tell how long: the loader turns in eighths, 8 steps a second from the
 * shared timer (`ticker.ts`), with no easing. Not a native loop: that holds the window at full frame rate. Under
 * reduced motion it stays still (a still arc still says "busy"; the control carrying it says so too: `Btn loading`
 * adds "busy" to its label).
 */
export function Spinner(props: { size?: 12 | 14 | 16 | 20; tone?: IconTone }) {
  const tick = useTicker();
  const motionless = reducedMotion();
  return (
    <View class={motionless ? "" : turnClass(tick())}>
      <Icon name="loader" size={props.size} tone={props.tone} />
    </View>
  );
}

/**
 * A placeholder with the size of what will load, so the page does not shift when it arrives. Still: holding the shape
 * is the job, and a pulse is an endless native loop that costs full-rate frames for the whole wait (nsh issue 958).
 * Give it the real width and height.
 */
export function Skeleton(props: { class?: string }) {
  return <View class={`rounded-md bg-muted ${props.class ?? ""}`} />;
}
