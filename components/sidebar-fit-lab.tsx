import { host, mount, Text, View } from "nsh";

import { Project } from "#components/sidebar";
import { PopupRoot, ThemeRoot } from "#kit";
import { board, startHerdr } from "#lib/herdr";
import type { SidebarItem } from "#lib/sidebar";

startHerdr("", "mixed");

const widths = [264, Number(host.params.wide) || 520];
const cases = [
  { name: "payments-api", machine: "fatman" },
  { name: "herdr-desktop-monorepo", machine: "tuannd12" },
  { name: "a-very-long-project-name-that-cannot-fit-at-all", machine: "workstation" },
  { name: "web", machine: null },
  { name: "mwmwmw", machine: "mwmwmw" },
];

/** The entry for a render of project headers as the sidebar draws them at a narrow and a wide panel. Not part of the app. */
function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 flex-row gap-4 bg-background">
        <Each of={widths} key="index">
          {(w) => (
            <View class="bg-sidebar" style={{ width: w() }}>
              <Text class="p-3 text-xs text-muted-foreground">{`panel ${w()}`}</Text>
              <If when={board().projects.length > 0}>
                <Each of={cases} key="index">
                  {(c) => {
                    const item = {
                      kind: "project",
                      key: `${w()}-${c().name}`,
                      project: { ...board().projects[0], name: c().name },
                      machine: c().machine,
                      stale: false,
                      folded: false,
                    } as unknown as Extract<SidebarItem, { kind: "project" }>;
                    return <Project item={() => item} />;
                  }}
                </Each>
              </If>
            </View>
          )}
        </Each>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
