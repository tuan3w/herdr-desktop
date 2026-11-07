import { Herdr } from "herdr-desktop/native";
import { computed, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { MachineStatus } from "herdr-desktop/native";

import { StatusGlyph } from "#components/status-glyph";
import { Btn, FOCUS_RING_SIDEBAR } from "#kit";
import { openSettings } from "#lib/actions";
import { revision, started } from "#lib/herdr";
import { linkGlyph, linkText } from "#lib/machine-state";
import { hoverTransition } from "#lib/motion";
import { footerMachines } from "#lib/sidebar";

const expanded = signal(false);

/** Every machine's link. Empty until the engine runs (this module loads before `Herdr.configure`). */
const statuses = computed<MachineStatus[]>(() => {
  if (!started()) return [];
  revision();
  return Herdr.machineStatuses();
});

/**
 * One machine that is not online: its name in the warning colour, a dashed or half ring (never colour alone), what
 * happened and what happens next. The text wraps: what to do is never cut. `Fix` only where the person must act.
 * Not a live region: a machine going down is also the dashed rows and the amber project headers.
 */
function Line(props: { machine: MachineStatus }) {
  const m = () => props.machine;
  const open = () => openSettings("machines");
  return (
    <View class="gap-1">
      <Button
        onPress={open}
        accessibilityLabel={`${m().name}, ${linkText(m())}`}
        style={hoverTransition()}
        class={`flex-row items-start gap-2 rounded-md px-2 py-1 hover:bg-sidebar-accent/60 ${FOCUS_RING_SIDEBAR}`}
      >
        <View class="pt-0.5">
          <StatusGlyph status={linkGlyph(m().state)} size={12} />
        </View>
        <View class="min-w-0 flex-1">
          <Text class={`text-xs font-medium ${m().state === "connecting" ? "text-muted-foreground" : "text-warning"}`}>
            {m().name}
          </Text>
          <Text class="text-xs text-muted-foreground">{linkText(m())}</Text>
        </View>
      </Button>
      <If when={m().state === "attention"}>
        <View class="items-start px-2 pb-1">
          <Btn small variant="outline" label="Fix" name={`Fix ${m().name}`} onPress={open} />
        </View>
      </If>
    </View>
  );
}

/**
 * The lines for these links: nothing when every machine is online (a row saying "all good" is the noise a supervisor
 * learns to skip). Past three broken machines the rest fold into `and N more machines`, one line that opens them.
 * Apart from `SidebarFooter` so a test entry can show states the scripted herdr cannot make (needs attention).
 */
export function FooterLines(props: { statuses: readonly MachineStatus[] }) {
  const shown = () => footerMachines(props.statuses, expanded());
  return (
    <If when={shown().lines.length > 0}>
      <View role="group" accessibilityLabel="Machines" class="gap-1">
        <Each of={shown().lines} key={(m: MachineStatus) => m.id}>
          {(m) => <Line machine={m()} />}
        </Each>
        <If when={shown().more > 0}>
          <Button
            onPress={() => expanded.set(true)}
            accessibilityLabel={`Show ${shown().more} more machines that are not connected`}
            style={hoverTransition()}
            class={`rounded-md px-2 py-1 hover:bg-sidebar-accent/60 ${FOCUS_RING_SIDEBAR}`}
          >
            <Text class="text-xs text-muted-foreground">
              {`and ${shown().more} more machine${shown().more === 1 ? "" : "s"}`}
            </Text>
          </Button>
        </If>
      </View>
    </If>
  );
}

/** The bottom of the sidebar: connection truth per machine, exceptions only. */
export function SidebarFooter() {
  return <FooterLines statuses={statuses()} />;
}
