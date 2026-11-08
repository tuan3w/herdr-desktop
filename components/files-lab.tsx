import { Files as MachineFiles } from "herdr-desktop/native";
import { host, keymap, mount, signal, Text, View } from "nsh";

import { FilesTab } from "#components/files";
import { openLink } from "#components/open-link";
import { SendFiles } from "#components/send-files";
import { WebPage } from "#components/web-page";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { pageRequest, sending } from "#lib/files";
import { startHerdr } from "#lib/herdr";
import { browseFiles, lastAsked, viewFile } from "#lib/open-files";
import { searchInPane } from "#lib/pane-input";
import { GLOBAL, keysOf } from "#lib/shortcuts";

/**
 * The entry of the file tests and of the files screenshots: the scripted herdr, a synthetic folder the test seam copied
 * into the data directory (`Files.testTree`), and buttons that open the browser, the viewer, a link and the send dialog
 * on it. `host.params.dir` opens another folder (a test of an error); `host.params.open` opens a folder of the tree at
 * once. Not part of the app.
 */
startHerdr("", "mixed");
const tree = MachineFiles.testTree();
const other = typeof host.params.dir === "string" ? host.params.dir : tree;
// `host.params.open`: a folder of the tree to open at once (a Mac screenshot cannot press the buttons).
if (typeof host.params.open === "string") browseFiles("local", `${tree}/${host.params.open}`);

function Lab() {
  const said = signal("nothing yet");
  // The app binds its global shortcuts in `App.tsx`; the one a viewer answers is bound here the same way.
  keymap.bind({ [keysOf(GLOBAL.search)[0]]: searchInPane });
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 flex-row">
          <View class="w-[300px] shrink-0 gap-2 p-4">
            <Btn label="Browse files" onPress={() => browseFiles("local", other)} />
            <Btn label="Browse the docs folder" onPress={() => browseFiles("local", `${tree}/docs`)} />
            <Btn label="View the readme" onPress={() => viewFile("local", `${tree}/README.md`)} />
            <Btn label="View the design notes" onPress={() => viewFile("local", `${tree}/docs/design.md`)} />
            <Btn label="View main.rs at line 12" onPress={() => viewFile("local", `${tree}/src/main.rs`, 12)} />
            <Btn
              label="Open link src/ledger.py"
              onPress={() => void openLink("path", "src/ledger.py", 3, null, { machine: "local", cwd: `${tree}/docs` })}
            />
            <Btn
              label="Open link missing.rs"
              onPress={() =>
                void openLink("path", "missing.rs", null, null, { machine: "local", cwd: `${tree}/docs` }).then(() =>
                  said.set("link done"),
                )
              }
            />
            <Btn
              label="Send data.bin to docs"
              onPress={() => sending.set({ machine: "local", folder: `${tree}/docs`, paths: [`${tree}/data.bin`] })}
            />
            <Btn
              label="Open a page of this computer"
              onPress={() => pageRequest.set({ machine: "local", url: "http://localhost:5173/" })}
            />
            <Text>{said()}</Text>
          </View>
          {/* The tab area is the app's; the lab draws the Files tab asked for beside its buttons. */}
          <If when={lastAsked()}>{(id) => <FilesTab id={id()} active />}</If>
        </View>
        <SendFiles />
        <WebPage />
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
