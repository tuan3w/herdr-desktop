import { Herdr, Sessions } from "herdr-desktop/native";
import { computed, Text, View } from "nsh";

import { NUM, Progress, Swap } from "#kit";
import { focused, parseSessionKey } from "#lib/dock";
import { board, revision } from "#lib/herdr";

/**
 * The slim bar under the workspace: how many machines are connected and how many agents need you or work (the same
 * counts as the status line and the window title), and, while a chat is in front, how much of its context window is
 * used. Only what the app knows is shown: a usage meter an agent does not report is not drawn, and nothing here is
 * ever an estimate. Not a live region: the sidebar and the window title announce changes.
 */
export function StatusBar() {
  const machines = computed(() => {
    revision();
    return Herdr.machineStatuses().filter((m) => m.state !== "off");
  });
  const connected = () => machines().filter((m) => m.state === "online").length;
  const context = computed(() => {
    revision();
    const at = parseSessionKey(focused());
    return at ? (Sessions.view(at.machine, at.id)?.contextPercent ?? null) : null;
  });
  const hosts = () => {
    const total = machines().length;
    if (connected() === total) return total === 1 ? "1 machine" : `${total} machines`;
    return `${connected()} of ${total} machines connected`;
  };
  return (
    <View
      role="group"
      accessibilityLabel="Status"
      class="h-8 flex-row items-center justify-between gap-4 border-t border-border bg-sidebar px-4"
    >
      <View class="flex-row items-center gap-3">
        <Text
          style={NUM}
          class={`text-xs ${connected() === machines().length ? "text-muted-foreground" : "font-medium text-foreground"}`}
        >
          {hosts()}
        </Text>
        <If when={board().counts.needsYou > 0}>
          <Swap
            class="text-xs font-medium text-foreground"
            text={`${board().counts.needsYou} need${board().counts.needsYou === 1 ? "s" : ""} you`}
          />
        </If>
        <If when={board().counts.working > 0}>
          <Swap class="text-xs text-muted-foreground" text={`${board().counts.working} working`} />
        </If>
      </View>
      <If when={context() !== null}>
        <View class="flex-row items-center gap-2">
          <Text style={NUM} class="text-xs text-muted-foreground">{`Context ${context()}%`}</Text>
          <Progress label="Context used" value={context()} class="w-20" />
        </View>
      </If>
    </View>
  );
}
