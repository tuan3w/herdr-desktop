import { host, mount, signal, Text, View } from "nsh";

import type { MachineStatus } from "herdr-desktop/native";

import { FooterLines } from "#components/sidebar-footer";
import { Btn, PopupRoot, ThemeRoot } from "#kit";
import { settingsPage } from "#lib/actions";

const m = (id: string, over: Partial<MachineStatus>): MachineStatus => ({
  id,
  name: id,
  state: "online",
  newerHerdr: false,
  agents: 0,
  needsYou: 0,
  ...over,
});

const SETS: Record<string, MachineStatus[]> = {
  online: [m("local", { name: "This computer" }), m("devbox", {})],
  mixed: [
    m("local", { name: "This computer" }),
    m("build", { name: "Build box", state: "offline", detail: "ssh: connection refused", retryInSecs: 4 }),
    m("gpu", { name: "GPU rig", state: "attention", detail: "run ssh gpu once in a terminal to trust the host" }),
    m("old", { name: "Old laptop", state: "off" }),
  ],
  many: Array.from({ length: 6 }, (_, i) => m(`m${i}`, { name: `Box ${i + 1}`, state: "offline" })),
};

/** The entry of `sidebar-footer.test.tsx`: the footer over fixed machine links, in a sidebar-wide column. Not part of the app. */
function Lab() {
  const set = signal(
    typeof host.params.fixture === "string" && host.params.fixture in SETS ? host.params.fixture : "online",
  );
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 flex-row gap-4 bg-background">
        <View style={{ width: 280 }} class="justify-end bg-sidebar p-3">
          <FooterLines statuses={SETS[set()]} />
        </View>
        <View class="gap-1 p-4">
          <Btn label="Show a stale and a stuck machine" onPress={() => set.set("mixed")} />
          <Btn label="Show six down" onPress={() => set.set("many")} />
          <Text>{`settings page ${settingsPage() ?? "closed"}`}</Text>
        </View>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
