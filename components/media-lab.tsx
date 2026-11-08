import { Files as MachineFiles, Herdr, Media } from "herdr-desktop/native";
import { host, keymap, mount, signal, Text, View } from "nsh";

import { FilesTab } from "#components/files";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";
import { clock, shownPlayer } from "#lib/media";
import { browseFiles, lastAsked, viewFile } from "#lib/open-files";
import { registerPane, searchInPane } from "#lib/pane-input";
import { GLOBAL, keysOf } from "#lib/shortcuts";

/**
 * The entry of the media and viewer tests, screenshots and measurements: the scripted herdr, the synthetic folders the test
 * seam copied into the data directory (`Files.testSet`: `media` and `viewers`, plus `project`), and a button for each
 * viewer. `host.params.long` names a long clip for the budget run; `host.params.slowCopy` and `host.params.cap` make a local file take the remote path (copied, slowly, into a cache of that cap); `host.params.sim` adds the buttons a headless test
 * plays the media engine with (it has none). Not part of the app.
 */
startHerdr("", "mixed");
const media = MachineFiles.testSet("media");
const viewers = MachineFiles.testSet("viewers");
const project = MachineFiles.testTree();
// `slowCopy`: copy this computer's files like another machine's, each report `slowCopy` ms apart; `cap`: the cache's cap in bytes.
// Always set: the switches are the process's, and a lab that does not ask for them must not inherit the last one's.
const slow = typeof host.params.slowCopy === "number" ? host.params.slowCopy : null;
Media.testSlowCopies(slow !== null, slow ?? 0);
Media.testCap(typeof host.params.cap === "number" ? host.params.cap : 1024 * 1024 * 1024);
const long = typeof host.params.long === "string" ? host.params.long : null;
const sim = host.params.sim === true;
// A text file of about 7 MB, over the 4 MB the viewer holds: it is paged by lines.
const big = Media.testBigLog(typeof host.params.lines === "number" ? host.params.lines : 120_000);
// A sparse picture one byte over what the viewer hands to the window: the too-large message.
const hugePicture = Media.testBigPicture();

/** What `Probe shot-2.png` found: the start and the length of the address the viewer is given. */
const probed = signal("");

/** What the open chat was asked to mention. */
const mentioned = signal("");

/** Seconds of the sim clock: the time the buttons say the engine reports. */
const simTime = signal(0);

function Lab() {
  // The app binds its global shortcuts in `App.tsx`; the one a viewer answers is bound here the same way.
  keymap.bind({ [keysOf(GLOBAL.search)[0]]: searchInPane });
  const cycles = signal("");
  const player = shownPlayer;

  // Opens and closes the player twenty times, then says the process's memory before and after.
  const churn = async (name: string, what: string) => {
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const before = Herdr.metrics().rssMb;
    for (let i = 0; i < 20; i++) {
      viewFile("local", name);
      await wait(700);
      lastAsked.set(null);
      await wait(300);
    }
    cycles.set(
      `20 ${what} viewers closed · RSS ${before.toFixed(0)} MB before, ${Herdr.metrics().rssMb.toFixed(0)} MB after`,
    );
  };

  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 flex-row">
          <View class="w-[420px] shrink-0 flex-row flex-wrap content-start items-start gap-2 p-4">
            <Btn label="Browse media" onPress={() => browseFiles("local", media)} />
            <Btn label="Play clip.ogv" onPress={() => viewFile("local", `${media}/clip.ogv`)} />
            <Btn label="Play song.ogg" onPress={() => viewFile("local", `${media}/song.ogg`)} />
            <Btn label="Play tone.wav" onPress={() => viewFile("local", `${media}/tone.wav`)} />
            <Btn label="Play hevc.mp4" onPress={() => viewFile("local", `${media}/hevc.mp4`)} />
            <Btn label="Play broken.mp4" onPress={() => viewFile("local", `${media}/broken.mp4`)} />
            <If when={long}>
              {(path) => <Btn label="Play the long clip" onPress={() => viewFile("local", path())} />}
            </If>
            <Btn label="Browse viewers" onPress={() => browseFiles("local", viewers)} />
            <Btn label="View report.pdf" onPress={() => viewFile("local", `${viewers}/report.pdf`)} />
            <Btn label="View bundle.zip" onPress={() => viewFile("local", `${viewers}/bundle.zip`)} />
            <Btn label="View bundle.tar.gz" onPress={() => viewFile("local", `${viewers}/bundle.tar.gz`)} />
            <Btn label="View table.csv" onPress={() => viewFile("local", `${viewers}/table.csv`)} />
            <Btn label="View config.json" onPress={() => viewFile("local", `${viewers}/config.json`)} />
            <Btn label="View logo.svg" onPress={() => viewFile("local", `${viewers}/logo.svg`)} />
            <Btn label="View server.log" onPress={() => viewFile("local", `${viewers}/server.log`)} />
            <Btn label="View tool.bin" onPress={() => viewFile("local", `${viewers}/tool.bin`)} />
            <Btn label="View shot-2.png" onPress={() => viewFile("local", `${project}/assets/shot-2.png`)} />
            <Btn
              label="Probe shot-2.png"
              onPress={() =>
                void MachineFiles.open("local", `${project}/assets/shot-2.png`).then((d) =>
                  probed.set(`probe: ${(d.image ?? "none").slice(0, 22)} ${(d.image ?? "").length}`),
                )
              }
            />
            <Text>{probed()}</Text>
            <Btn label="Browse project" onPress={() => browseFiles("local", project)} />
            <Btn label="View big.log" onPress={() => viewFile("local", big)} />
            <Btn label="View huge.png" onPress={() => viewFile("local", hugePicture)} />
            <Btn
              label="Open the chat"
              onPress={() =>
                registerPane({
                  focusComposer: () => {},
                  mention: (m, p) => {
                    mentioned.set(`${m} ${p}`);
                    return true;
                  },
                })
              }
            />
            <Btn label="Open and close 20 viewers" onPress={() => void churn(`${media}/clip.ogv`, "video")} />
            <Btn label="Open and close 20 text viewers" onPress={() => void churn(`${viewers}/server.log`, "text")} />
            <If when={sim}>
              <Btn
                label="Sim loaded 125 s"
                onPress={() => player()?.loaded({ duration: 125, width: 320, height: 180 })}
              />
              <Btn
                label="Sim loaded sound 125 s"
                onPress={() => player()?.loaded({ duration: 125, width: 0, height: 0 })}
              />
              <Btn
                label="Sim progress +5 s"
                onPress={() => {
                  simTime.update((t) => t + 5);
                  player()?.progress({ currentTime: simTime(), duration: 125 });
                }}
              />
              <Btn label="Sim ended" onPress={() => player()?.ended()} />
              <Btn label="Sim error" onPress={() => player()?.failed("Missing a plug-in to decode this format")} />
            </If>
            <View class="w-full gap-1">
              <Text>{cycles()}</Text>
              <Text>{mentioned() === "" ? "nothing mentioned" : `mentioned ${mentioned()}`}</Text>
              <Text>{`player ${player() ? `${player()!.state()} at ${clock(player()!.position())}` : "none"}`}</Text>
              <Text>{`volume ${player() ? Math.round(player()!.volume() * 100) : 100}%`}</Text>
            </View>
          </View>
          {/* The tab area is the app's; the lab draws the Files tab asked for beside its buttons. */}
          <If when={lastAsked()}>{(id) => <FilesTab id={id()} active />}</If>
        </View>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
