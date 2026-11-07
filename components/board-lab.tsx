import { host, mount, signal, Text, View } from "nsh";

import { Board } from "#components/board";
import { BulkBar } from "#components/bulk-bar";
import { ThemeRoot, ToastHost } from "#kit";
import { newSessionProject } from "#lib/actions";
import { startHerdr } from "#lib/herdr";
import { loadSidebar } from "#lib/sidebar";

/**
 * The entry of `board.test.tsx` and `bulk.test.tsx`: the board and the bulk bar against a scripted
 * herdr (`fixture` is a launch parameter), and a line that says what the board was asked to open. Not part of the app.
 */
const params = host.params as { fixture?: string };
startHerdr("", params.fixture ?? "mixed");
void loadSidebar();

function Lab() {
  const opened = signal("nothing opened");
  const machine = signal("no machine added");
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background">
        <Text class="px-4 pt-2 text-xs text-muted-foreground">{opened()}</Text>
        <Text class="px-4 text-xs text-muted-foreground">{machine()}</Text>
        <Text class="px-4 text-xs text-muted-foreground">{`new session in ${newSessionProject()?.folder ?? "nowhere"}`}</Text>
        <Board
          onOpen={(row, options) =>
            opened.set(`opened ${row.machine}/${row.paneId}${options?.reply ? " to reply" : ""}`)
          }
          onAddMachine={() => machine.set("add machine asked")}
        />
        <BulkBar />
      </View>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
