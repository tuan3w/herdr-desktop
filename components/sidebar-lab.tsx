import { Herdr } from "herdr-desktop/native";
import { host, mount, Text, View } from "nsh";

import { Sidebar } from "#components/sidebar";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { newSessionOpen, newSessionProject, settingsPage } from "#lib/actions";
import { focused, paneKey } from "#lib/dock";
import { allRows, board, revision, startHerdr } from "#lib/herdr";
import { selected } from "#lib/selection";
import { loadSidebar, treeOffset } from "#lib/sidebar";

import big from "../fixtures/herdr/big.json";

const fixture = host.params.fixture;
startHerdr("", typeof fixture === "string" ? fixture : "mixed");
void loadSidebar();

/** How many times a button changed an agent of the `big` fixture. */
let changes = 0;

/** What happens in a long run: a working agent of the `big` fixture finishes, then works again, and the sidebar is told. */
function changeAnAgent() {
  changes += 1;
  const snapshot = JSON.parse(JSON.stringify(big.snapshot)) as typeof big.snapshot;
  const agent = snapshot.agents.find((a) => a.agent_status === "working")!;
  agent.agent_status = changes % 2 === 1 ? "done" : "working";
  agent.state_change_seq += changes;
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({
    event: "pane_agent_status_changed",
    data: { pane_id: agent.pane_id, agent_status: agent.agent_status },
  });
}

/** The person switches to the agent at the `end` of the list, as `mod+j` or the switcher would: only the focused tab moves. */
function goTo(end: "first" | "last") {
  // An agent that is doing something is always listed (idle ones can sit behind `N more idle`).
  const rows = allRows(board()).filter((r) => r.status === "working" || r.status === "blocked");
  const row = end === "first" ? rows[0] : rows[rows.length - 1];
  focused.set(paneKey(row.machine, row.paneId));
}

/** The entry of `sidebar.test.tsx`: the sidebar beside lines that say what its buttons did. Not part of the app. */
function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 flex-row bg-background">
        <View style={{ width: 280 }}>
          <Sidebar />
        </View>
        <View class="flex-1 gap-1 p-4">
          <Btn label="Change an agent" onPress={changeAnAgent} />
          <Btn
            label="Add an unreachable machine"
            onPress={() => Herdr.saveMachine({ name: "Build box", dest: "devbox.invalid", enabled: true })}
          />
          <Btn label="Go to the last agent" onPress={() => goTo("last")} />
          <Btn label="Go to the first agent" onPress={() => goTo("first")} />
          <Text>{`new session dialog ${newSessionOpen() ? "open" : "closed"}`}</Text>
          <Text>{`new session folder ${newSessionProject()?.folder ?? "none"}`}</Text>
          <Text>{`settings page ${settingsPage() ?? "closed"}`}</Text>
          <Text>{`picked ${selected().length}`}</Text>
          <Text>{`board tick ${revision()}`}</Text>
          <Text>{`tree offset ${Math.round(treeOffset())}`}</Text>
        </View>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
