import { signal, Text, View } from "nsh";
import type { PlanStatusName, PlanStepView } from "herdr-desktop/native";
import { Btn, Icon, type IconName } from "./kit";

/** A step's shape: done is a check, working a loader, waiting a clock; the word is always beside it. */
const STEP: Record<PlanStatusName, { icon: IconName; word: string }> = {
  completed: { icon: "circle-check", word: "done" },
  inProgress: { icon: "loader", word: "now" },
  pending: { icon: "clock", word: "next" },
};

/**
 * The agent's plan, folded to the step it is on (`Plan · step 2 of 5: Run the tests`) with `Show plan` to list every
 * step. Nothing when the agent has no plan. Used by the permission dock and the session overview.
 */
export function PlanSteps(props: { plan: readonly PlanStepView[]; /** Start with every step listed. */ open?: boolean }) {
  const open = signal(props.open ?? false);
  const current = () => {
    const at = props.plan.findIndex((s) => s.status !== "completed");
    return at < 0 ? props.plan.length - 1 : at;
  };
  return (
    <If when={props.plan.length > 0}>
      <View role="group" accessibilityLabel="Plan" class="gap-1">
        <View class="flex-row items-center justify-between gap-3">
          <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {`Plan · step ${current() + 1} of ${props.plan.length}: ${props.plan[current()]?.content ?? ""}`}
          </Text>
          <Btn small variant="ghost" label={open() ? "Hide plan" : "Show plan"} onPress={() => open.update((v) => !v)} />
        </View>
        <If when={open()}>
          <Each of={props.plan} key="index">
            {(step) => (
              <View accessibilityLabel={`${step().content}, ${STEP[step().status].word}`} class="flex-row items-start gap-2 pl-1">
                <Icon name={STEP[step().status].icon} size={14} tone={step().status === "completed" ? "success" : "muted-foreground"} />
                <Text class="min-w-0 flex-1 text-sm text-foreground">{step().content}</Text>
                <Text class="text-xs text-muted-foreground">{STEP[step().status].word}</Text>
              </View>
            )}
          </Each>
        </If>
      </View>
    </If>
  );
}
