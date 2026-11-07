import { cleanup, createMotion, View } from "nsh";
import { reducedMotion } from "#lib/motion";

/** How far along, 0 to 1, clamped; undefined when the extent is unknown (`value` null, or a range with no width). */
export function progressRatio(value: number | null | undefined, min: number, max: number): number | undefined {
  if (value === null || value === undefined || Number.isNaN(value) || max <= min) return undefined;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** What a screen reader hears as the value: the caller's words, else the percentage; nothing known says it is working. */
export function progressText(ratio: number | undefined, valueText?: string): string {
  if (valueText) return valueText;
  return ratio === undefined ? "busy" : `${Math.round(ratio * 100)}%`;
}

/** The bar of work whose extent is unknown: it breathes (opacity only) while mounted, still under reduced motion. */
function Working() {
  const pulse = createMotion();
  if (!reducedMotion()) {
    void pulse.play({ keyframes: { opacity: [1, 0.4, 1] }, duration: 1400, easing: "easeInOut", iterations: "infinite" });
    cleanup(() => pulse.stop());
  }
  return <View style={pulse.style} class="h-1 w-full rounded-full bg-primary" />;
}

/**
 * How far a task with a known extent is (Base UI's Progress, no Meter: a gauge has no use here): `value` from `min` to
 * `max` (0 to 100), or `null` when the extent is unknown (it then breathes instead of filling). `label` names it;
 * `valueText` is what a screen reader hears as the value when the percentage is not the point ("2/5 tasks done").
 * The fill is set by width and never animates (`design/motion.md`); the text beside it is the caller's.
 */
export function Progress(props: { value: number | null; label: string; valueText?: string; min?: number; max?: number; class?: string }) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const ratio = () => progressRatio(props.value, min(), max());
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: min(), max: max(), now: props.value === null ? undefined : props.value, text: progressText(ratio(), props.valueText) }}
      class={`h-1 overflow-hidden rounded-full bg-muted ${props.class ?? ""}`}
    >
      <If when={ratio() !== undefined} else={<Working />}>
        <View class="h-1 rounded-full bg-primary" style={{ width: `${(ratio() ?? 0) * 100}%` }} />
      </If>
    </View>
  );
}
