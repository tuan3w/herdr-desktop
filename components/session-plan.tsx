import { signal, Text, View } from "nsh";

import type { PlanStepView } from "herdr-desktop/native";

import { Disclosure } from "#components/session-tool";
import { StatusGlyph } from "#components/status-glyph";
import { Clipped, Icon } from "#kit";

/** `1 of 3 done` and the step being worked on (else the first still to do): the one line a collapsed plan says. */
export function planLine(plan: readonly PlanStepView[]): { progress: string; current: string } {
  const done = plan.filter((s) => s.status === "completed").length;
  const now = plan.find((s) => s.status === "inProgress") ?? plan.find((s) => s.status === "pending");
  return { progress: `${done} of ${plan.length} done`, current: now?.content ?? "" };
}

/**
 * The agent's plan as a checklist that changes in place: a line under the header (`Plan · 1 of 3 done · Run the tests`)
 * that opens to every step with its state as a shape (empty ring to do, half ring doing, check done). It takes room only
 * while the plan has steps to do or a turn runs, so a finished plan is not a permanent bar.
 */
export function SessionPlan(props: { plan: readonly PlanStepView[]; running: boolean }) {
  const open = signal(false);
  const line = () => planLine(props.plan);
  const shown = () => props.plan.length > 0 && (props.running || props.plan.some((s) => s.status !== "completed"));
  return (
    <If when={shown()}>
      <View class="border-b border-border px-2 py-1">
        <Disclosure
          label={`Plan, ${line().progress}${line().current ? `, now ${line().current}` : ""}`}
          open={open()}
          onPress={() => open.update((o) => !o)}
          class="min-h-9 flex-row items-center gap-2 rounded-md px-2"
        >
          <Icon name={open() ? "chevron-down" : "chevron-right"} size={14} tone="muted-foreground" />
          <Text class="text-sm font-medium text-foreground">Plan</Text>
          <Text class="text-sm text-muted-foreground">{`· ${line().progress}`}</Text>
          <View class="min-w-0 flex-1">
            <Clipped class="text-sm text-muted-foreground" tip={false}>
              {open() ? "" : line().current}
            </Clipped>
          </View>
        </Disclosure>
        <If when={open()}>
          <View role="list" accessibilityLabel="Plan steps" class="gap-1 px-2 pb-2 pl-8">
            <Each of={props.plan as PlanStepView[]} key="index">
              {(step) => (
                <View
                  role="group"
                  accessibilityLabel={`${step().content}, ${step().status === "completed" ? "done" : step().status === "inProgress" ? "in progress" : "to do"}`}
                  class="flex-row items-start gap-2 py-1"
                >
                  <View class="pt-1">
                    <StatusGlyph
                      status={
                        step().status === "completed" ? "done" : step().status === "inProgress" ? "working" : "idle"
                      }
                      size={12}
                    />
                  </View>
                  <Text
                    class={`min-w-0 flex-1 text-sm ${step().status === "completed" ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {step().content}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
