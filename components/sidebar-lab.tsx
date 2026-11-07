import { host, mount, Text, View } from "nsh";
import { machinesOpen, newSessionOpen, newSessionProject, settingsOpen } from "../lib/actions";
import { startHerdr } from "../lib/herdr";
import { selected } from "../lib/selection";
import { loadSidebar } from "../lib/sidebar";
import { PopupRoot, ThemeRoot, ToastHost } from "./kit";
import { Sidebar } from "./sidebar";

const fixture = host.params.fixture;
startHerdr("", typeof fixture === "string" ? fixture : "mixed");
void loadSidebar();

/** The entry of `sidebar.test.tsx`: the sidebar beside lines that say what its buttons did. Not part of the app. */
function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 flex-row bg-background">
        <View style={{ width: 280 }}>
          <Sidebar />
        </View>
        <View class="flex-1 gap-1 p-4">
          <Text>{`machines dialog ${machinesOpen() ? "open" : "closed"}`}</Text>
          <Text>{`new session dialog ${newSessionOpen() ? "open" : "closed"}`}</Text>
          <Text>{`new session folder ${newSessionProject()?.folder ?? "none"}`}</Text>
          <Text>{`settings dialog ${settingsOpen() ? "open" : "closed"}`}</Text>
          <Text>{`picked ${selected().length}`}</Text>
        </View>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
