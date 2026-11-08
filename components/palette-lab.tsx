import { Files as MachineFiles, Herdr } from "herdr-desktop/native";
import { cleanup, effect, mount, Text, View } from "nsh";

import { Palette } from "#components/palette";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { context } from "#lib/dock";
import { board, startHerdr } from "#lib/herdr";
import { lastAsked, requests } from "#lib/open-files";
import { openPalette, palette } from "#lib/palette/controller";
import { projectFolder } from "#lib/sidebar";

import mixed from "../fixtures/herdr/mixed.json";

/**
 * The entry of the palette's file tests and screenshots: the scripted herdr with the `payments` project moved to a
 * synthetic folder the test seam copied into the data directory (`Files.testTree`), the project shown as the one the
 * person is in, and the palette on top. A line says which file the viewer was asked to open. Not part of the app.
 */
startHerdr("", "mixed");
const tree = MachineFiles.testTree();
const snapshot = JSON.parse(JSON.stringify(mixed.snapshot)) as typeof mixed.snapshot;
for (const p of [...snapshot.panes, ...snapshot.agents]) if (p.workspace_id === "w1") p.cwd = tree;
Herdr.testSetSnapshot(snapshot);

const asked = () => {
  const key = lastAsked();
  return key === null ? undefined : requests()[key]?.file;
};

function Lab() {
  // The project in front is where files are searched.
  effect(() => {
    const payments = board().projects.find((p) => p.name === "payments");
    if (payments) context.set(payments.key);
  });
  // The scripted herdr's board arrives after the window opens, slower on a slow machine: a test waits for this line.
  const folderReady = () => {
    const payments = board().projects.find((p) => p.name === "payments");
    return payments !== undefined && projectFolder(payments) === tree;
  };
  // The engine's first read of the scripted herdr can land before or after the folders above were set (and its next poll is
  // 20 s away): ask for a read again until the board shows them, so a slow machine only waits as long as it must.
  const nudge = setInterval(() => {
    if (folderReady()) clearInterval(nudge);
    else Herdr.testPush({ event: "workspace_updated", data: {} });
  }, 150);
  cleanup(() => clearInterval(nudge));
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 gap-2 p-4">
          <Btn label="Open palette" onPress={() => openPalette()} />
          <Btn label="Find a file" onPress={() => openPalette("files")} />
          <Text>{folderReady() ? "project folder ready" : "waiting for the project folder"}</Text>
          <Text>{asked() ? `viewer opened ${asked()?.replace(tree, "")}` : "no file opened"}</Text>
        </View>
        <Palette open={palette()} onClose={() => palette.set(false)} />
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
