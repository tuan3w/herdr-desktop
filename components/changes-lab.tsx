import { Git, Herdr } from "herdr-desktop/native";
import { host, keymap, mount, Text, View } from "nsh";

import { Changes } from "#components/changes";
import { PopupRoot, ThemeRoot, ToastHost, undoLast } from "#kit";
import { startHerdr } from "#lib/herdr";

import mixed from "../fixtures/herdr/mixed.json";

/**
 * The entry of the Changes tests and screenshots: the scripted herdr, a synthetic repository the test seam built in the
 * data directory (`Git.testRepo`, `host.params.kind`: `project` by default, `clean`, `many`, `big`, `conflict` or
 * `plain`), and the tab on it. The agents of the fixture that work in `/home/dev/auth` are moved into that repository, so
 * the notes have agents to go to: one waits for an answer, one is done (`both`: neither waits; `alone`: none works there).
 * `hidden` shows the tab as one that is not in front. Not part of the app.
 */
startHerdr("", "mixed");
const kind = typeof host.params.kind === "string" ? host.params.kind : "project";
const repo = Git.testRepo(kind);
if (host.params.alone === undefined) {
  const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
  for (const item of [...snapshot.agents, ...snapshot.panes]) {
    if (item.cwd === "/home/dev/auth") item.cwd = repo;
    // `both`: the agent that waits for an answer is idle instead, so two agents can take the notes.
    if (host.params.both !== undefined && item.pane_id === "w1:p2") item.agent_status = "idle";
  }
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({ event: "pane_agent_status_changed", data: { pane_id: "w1:p3", agent_status: "done" } });
}

function Lab() {
  // The app binds this key in `App.tsx`; the lab has no `Workspace`, so it binds it itself.
  keymap.bind({ "mod+z": () => undoLast() }, { when: "always" });
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1">
          <Changes machine="local" cwd={repo} active={host.params.hidden === undefined} />
          <Text accessibilityElementsHidden class="h-0 opacity-0">{`repo ${repo}`}</Text>
        </View>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
