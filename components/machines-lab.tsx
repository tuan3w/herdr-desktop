import { Herdr } from "herdr-desktop/native";
import { host, mount, signal, Text, View } from "nsh";

import { NameDialog } from "#components/name-dialog";
import { Settings } from "#components/settings";
import { StartAgent } from "#components/start-agent";
import { Btn, PopupRoot, ThemeRoot } from "#kit";
import { openSettings } from "#lib/actions";
import { revision, startHerdr } from "#lib/herdr";
import { pressTransition } from "#lib/motion";
import {
  announceOutput,
  codeLineNumbers,
  codeWhitespace,
  codeWrap,
  diffSplit,
  loadSettings,
  minContrast,
  terminalFontSize,
  reduceMotionOverride,
  themeId,
} from "#lib/settings";

/**
 * The entry of `machines.test.tsx`, `settings.test.tsx`, `start-agent.test.tsx` and `name-dialog.test.tsx`: the pages and dialogs of
 * this area over the `mixed` fixture's scripted herdr (`fixture` is a launch parameter), one button to open each, and readouts of
 * what they did. Not part of the app.
 */
startHerdr("", (host.params as { fixture?: string }).fixture ?? "mixed");
void loadSettings();

function Lab() {
  const start = signal(false);
  const name = signal<{
    open: boolean;
    initial?: string;
    confirm: string;
    title: string;
    allowEmpty?: boolean;
    helper?: string;
  }>({
    open: false,
    confirm: "Create",
    title: "New workspace",
  });
  const started = signal("nothing started");
  const named = signal("no name");
  const requests = signal("no requests");
  const count = () => (revision(), Herdr.machines().length);

  // A machine removed elsewhere (another window, another run) while its form is open.
  const forget = () => {
    const remote = Herdr.machines().find((m) => !m.local);
    if (remote) Herdr.removeMachine(remote.id);
  };

  const show = () => {
    const calls = ["workspace.create", "tab.create", "agent.start"].flatMap((method) =>
      Herdr.testRequests(method).map((r) => `${method} ${JSON.stringify(r.params)}`),
    );
    requests.set(calls.length ? calls.join(" | ") : "no requests");
  };

  // What ssh would print for three destinations, so machines added afterwards fail the way real ones do: a changed host
  // key and an untrusted one need the person (no retries), a refused connection is retried.
  const scriptSsh = () => {
    Herdr.testSshFault(
      "changed.example",
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
    );
    Herdr.testSshFault("unknown.example", "Host key verification failed.");
    Herdr.testSshFault("refused.example", "ssh: connect to host refused.example port 22: Connection refused");
  };

  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="gap-2 p-4">
          <View class="flex-row flex-wrap gap-2">
            <Btn label="Open machines" onPress={() => openSettings("machines")} />
            <Btn label="Open settings" onPress={() => openSettings()} />
            <Btn label="Open start agent" onPress={() => start.set(true)} />
            <Btn
              label="Rename workspace"
              onPress={() =>
                name.set({ open: true, initial: "payments", confirm: "Rename", title: "Rename workspace" })
              }
            />
            <Btn
              label="Rename pane label"
              onPress={() =>
                name.set({
                  open: true,
                  initial: "release check",
                  confirm: "Rename",
                  title: "Rename pane",
                  allowEmpty: true,
                  helper: "Leave empty to show the program's own title",
                })
              }
            />
            <Btn
              label="New workspace"
              onPress={() => name.set({ open: true, confirm: "Create", title: "New workspace" })}
            />
            <Btn label="Show requests" onPress={show} />
            <Btn label="Forget the remote machine" onPress={forget} />
            <Btn label="Script ssh failures" onPress={scriptSsh} />
          </View>
          <Text>{`machines=${count()}`}</Text>
          <Text>{started()}</Text>
          <Text>{named()}</Text>
          <Text>{requests()}</Text>
          <Text>{`font=${terminalFontSize()} contrast=${minContrast()} theme=${themeId()}`}</Text>
          <Text>{`announce=${announceOutput()} motion=${reduceMotionOverride()}`}</Text>
          <Text>{`code=${codeWrap()}/${codeLineNumbers()}/${codeWhitespace()}/${diffSplit()}`}</Text>
          <Text>{`notify=${(revision(), Herdr.setting("notify.needsYou") === true)}/${(revision(), Herdr.setting("notify.alsoDone") === true)}`}</Text>
          <Text>{`press=${pressTransition() === undefined ? "still" : "eased"}`}</Text>
        </View>
        <Settings />
        <StartAgent
          open={start()}
          onClose={() => start.set(false)}
          onStarted={(machine, pane) => started.set(`started ${machine} ${pane}`)}
        />
        <NameDialog
          open={name().open}
          title={name().title}
          initial={name().initial}
          confirm={name().confirm}
          allowEmpty={name().allowEmpty}
          helper={name().helper}
          onClose={() => name.set({ ...name(), open: false })}
          onSubmit={(value) => named.set(value === "" ? "name cleared" : `named ${value}`)}
        />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
