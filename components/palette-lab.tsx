import { Files as MachineFiles, Herdr } from "herdr-desktop/native";
import { effect, mount, Text, View } from "nsh";

import { Palette } from "#components/palette";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { context } from "#lib/dock";
import { browsing } from "#lib/files";
import { board, startHerdr } from "#lib/herdr";
import { openPalette, palette } from "#lib/palette/controller";

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

function Lab() {
  // The project in front is where files are searched.
  effect(() => {
    const payments = board().projects.find((p) => p.name === "payments");
    if (payments) context.set(payments.key);
  });
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 gap-2 p-4">
          <Btn label="Open palette" onPress={() => openPalette()} />
          <Btn label="Find a file" onPress={() => openPalette("files")} />
          <Text>{browsing()?.file ? `viewer opened ${browsing()?.file?.replace(tree, "")}` : "no file opened"}</Text>
        </View>
        <Palette open={palette()} onClose={() => palette.set(false)} />
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
