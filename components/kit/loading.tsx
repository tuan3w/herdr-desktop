import { createMotion, cleanup, reduceMotion, View } from "nsh";
import { Icon, type IconTone } from "./icon";

/**
 * Work is in progress and there is no way to tell how long: a spinning arc, 800ms a turn. Under reduced motion it
 * stays still (a still arc still says "busy"; the control carrying it says so too: `Btn loading` adds "busy" to its label).
 */
export function Spinner(props: { size?: 12 | 14 | 16 | 20; tone?: IconTone }) {
  const spin = createMotion();
  if (!reduceMotion()) {
    void spin.play({ keyframes: { rotate: [0, 360] }, duration: 800, easing: "linear", iterations: "infinite" });
    cleanup(() => spin.stop());
  }
  return (
    <View style={spin.style}>
      <Icon name="loader" size={props.size} tone={props.tone} />
    </View>
  );
}

/**
 * A placeholder with the size of what will load, so the page does not shift when it arrives. It breathes between
 * full and half opacity, 1.4s a cycle; under reduced motion it is a still block. Give it the real width and height.
 */
export function Skeleton(props: { class?: string }) {
  const pulse = createMotion();
  if (!reduceMotion()) {
    void pulse.play({ keyframes: { opacity: [1, 0.5, 1] }, duration: 1400, easing: "easeInOut", iterations: "infinite" });
    cleanup(() => pulse.stop());
  }
  return <View style={pulse.style} class={`rounded-md bg-muted ${props.class ?? ""}`} />;
}
