import { mount, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import { startHerdr } from "../lib/herdr";
import { StartAgent } from "./start-agent";
import { Btn, ThemeRoot } from "./kit";

/**
 * The entry of the failing half of `start-agent.test.tsx`: a herdr that answers `workspace.create` without naming what it
 * made, so every start fails. Not part of the app.
 */
startHerdr("", "start-fails");

function Lab() {
  const start = signal(false);
  const started = signal("nothing started");
  const requests = signal("no requests");
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <Btn label="Open start agent" onPress={() => start.set(true)} />
        <Btn label="Show requests" onPress={() => requests.set(`${Herdr.testRequests("workspace.create").length} workspace.create, ${Herdr.testRequests("agent.start").length} agent.start`)} />
        <Text>{started()}</Text>
        <Text>{requests()}</Text>
      </View>
      <StartAgent open={start()} onClose={() => start.set(false)} onStarted={(machine, pane) => started.set(`started ${machine} ${pane}`)} />
    </ThemeRoot>
  );
}

mount(Lab);
