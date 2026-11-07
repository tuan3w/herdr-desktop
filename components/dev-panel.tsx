import { Overlay, Text, View } from "nsh";
import { Button } from "nsh/base";
import { hoverTransition } from "../lib/motion";
import "../lib/native-metrics";
import { type Health, perfCollapsed, perfOpen, perfReadings, type Reading } from "../lib/perf";
import { keyLabel } from "../lib/shortcuts";
import { FOCUS_RING, Icon, IconButton, NUM } from "./kit";

const VALUE: Record<Health, string> = { ok: "text-popover-foreground", warn: "text-warning", bad: "text-destructive" };
const SHORTCUT = keyLabel("devPanel");

/** The worst health among the readings: the collapsed panel's summary takes its color. */
const worst = (readings: Reading[]): Health =>
  readings.some((r) => r.health === "bad") ? "bad" : readings.some((r) => r.health === "warn") ? "warn" : "ok";

/**
 * The developer panel: `lib/perf.ts` metrics, a line each, refreshed twice a second while it shows. The header folds it
 * to one line (a summary), the cross or the shortcut closes it. Only the panel itself takes presses; screen readers skip
 * the readings, which are for the person running the app. Labels are English on purpose.
 * The live pane path and the process (memory, threads, descriptors) come from Rust (`lib/native-metrics.ts`). CPU and GPU are
 * not here: `--fps` is nsh's own monitor (top right) and costs CPU itself: for CPU run `bun scripts/cpu.mjs`.
 */
export function DevPanel() {
  const summary = () => perfReadings().filter((r) => r.brief);
  return (
    <If when={perfOpen()}>
      <Overlay style={{ position: "absolute", right: 12, bottom: 12, pointerEvents: "box-none" }}>
        <View class={`rounded-lg border border-border bg-popover shadow-md ${perfCollapsed() ? "w-60" : "w-72"}`}>
          <View class="flex-row items-center pr-1">
            <Button
              onPress={() => perfCollapsed.update((c) => !c)}
              accessibilityLabel={perfCollapsed() ? "Expand dev panel" : "Collapse dev panel"}
              style={hoverTransition()}
              class={`h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent ${FOCUS_RING}`}
            >
              <Icon name={perfCollapsed() ? "chevron-right" : "chevron-down"} size={12} tone="muted-foreground" />
              <Text class="text-xs font-semibold text-popover-foreground">Dev</Text>
              <If when={perfCollapsed()}>
                <Text style={NUM} class={`font-mono text-xs line-clamp-1 ${VALUE[worst(perfReadings())]}`}>
                  {summary().map((r) => r.brief).join(" · ")}
                </Text>
              </If>
            </Button>
            <IconButton icon="x" label="Close dev panel" shortcut={SHORTCUT} onPress={() => perfOpen.set(false)} />
          </View>
          <If when={!perfCollapsed()}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" class="gap-1 px-3 pb-3">
              <Each of={perfReadings()} key={(r: Reading) => r.id}>
                {(r) => (
                  <View class="flex-row items-baseline justify-between gap-3">
                    <Text class="text-xs text-muted-foreground">{r().label}</Text>
                    <Text style={NUM} class={`font-mono text-xs line-clamp-1 ${VALUE[r().health]}`}>
                      {r().text}
                    </Text>
                  </View>
                )}
              </Each>
              <Text class="pt-1 text-xs text-muted-foreground">CPU: bun scripts/cpu.mjs. GPU: run with --fps</Text>
            </View>
          </If>
        </View>
      </Overlay>
    </If>
  );
}
