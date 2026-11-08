import { Files } from "herdr-desktop/native";
import { host, mount, Text, View } from "nsh";

import { NewSession } from "#components/new-session";
import { PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";

/**
 * The entry of the `Folder` path field's tests and screenshots: the scripted herdr, `New agent session` open on this
 * computer, and the synthetic folder the test seam copied into the data directory (`Files.testTree`: `assets`, `docs`
 * and `src`, a hidden file, no hidden folder). `host.params.start` is the folder the form opens on, `~tree` standing for
 * that folder; none opens it empty. Not part of the app.
 */
startHerdr("", "mixed");
const tree = Files.testTree();
const start = typeof host.params.start === "string" ? host.params.start.replace("~tree", tree) : undefined;

mount(() => (
  <ThemeRoot>
    <PopupRoot class="flex-1 bg-background">
      <View class="flex-1 p-4">
        <Text class="text-xs text-muted-foreground">{`tree:${tree}`}</Text>
        <NewSession
          open
          project={start ? { machine: "local", folder: start } : undefined}
          onClose={() => undefined}
          onStarted={() => undefined}
        />
      </View>
      <ToastHost />
    </PopupRoot>
  </ThemeRoot>
));
