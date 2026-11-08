import { View } from "nsh";

import { reducedMotion } from "#lib/motion";

import { useTicker } from "./ticker";

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

/** Positions of the moving segment, in tenths of the track: out and back, one step per tick. */
const SLIDE = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];

/**
 * The bar of work whose extent is unknown: a segment that steps along the track, 8 steps a second from the shared
 * timer (`ticker.ts`), still under reduced motion. A still bar was the quieter choice, but a full bar reads as done;
 * the segment costs 8 frames a second, not the 60 of a native loop.
 */
function Working() {
  const tick = useTicker();
  const at = () => (reducedMotion() ? 0 : SLIDE[tick() % SLIDE.length]);
  return (
    <View class="h-1 w-full">
      <View class="h-1 w-[30%] rounded-full bg-primary" style={{ marginLeft: `${at() * 10}%` }} />
    </View>
  );
}

/**
 * How far a task with a known extent is (Base UI's Progress, no Meter: a gauge has no use here): `value` from `min` to
 * `max` (0 to 100), or `null` when the extent is unknown (it then slides a segment instead of filling). `label` names it;
 * `valueText` is what a screen reader hears as the value when the percentage is not the point ("2/5 tasks done").
 * The fill is set by width and never animates (`design/motion.md`); the text beside it is the caller's.
 */
export function Progress(props: {
  value: number | null;
  label: string;
  valueText?: string;
  min?: number;
  max?: number;
  class?: string;
}) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const ratio = () => progressRatio(props.value, min(), max());
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={{
        min: min(),
        max: max(),
        // Clamped like the bar, so a value past the end is not announced as more than the whole.
        now: props.value === null ? undefined : Math.min(max(), Math.max(min(), props.value)),
        text: progressText(ratio(), props.valueText),
      }}
      class={`h-1 overflow-hidden rounded-full bg-muted ${props.class ?? ""}`}
    >
      <If when={ratio() !== undefined} else={<Working />}>
        <View class="h-1 rounded-full bg-primary" style={{ width: `${(ratio() ?? 0) * 100}%` }} />
      </If>
    </View>
  );
}
