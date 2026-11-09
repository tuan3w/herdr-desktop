import { Herdr } from "herdr-desktop/native";
import { computed, effect, openUrl, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { NotificationSupport } from "herdr-desktop/native";

import { Machines, machineForm } from "#components/machines";
import { LookPage } from "#components/settings-look";
import { Btn, copyText, FOCUS_RING, Modal, notify, SettingRow, Switch } from "#kit";
import { closeSettings, settingsPage } from "#lib/actions";
import type { SettingsPage } from "#lib/actions";
import { sizeText } from "#lib/files";
import { revision } from "#lib/herdr";
import { DIALOG_LARGE } from "#lib/layout";
import { hoverTransition } from "#lib/motion";
import { announceOutput, checkUpdates, largeTargets, reduceMotionOverride, settingsReady } from "#lib/settings";
import { checkForUpdate, UPDATE_COMMAND, updateCheck } from "#lib/updates";

import app from "../nsh.json";

/** The engine's settings keys of the two notification switches (`native/app/src/engine/alerts.rs`). */
const NOTIFY_NEEDS_YOU = "notify.needsYou";
const NOTIFY_ALSO_DONE = "notify.alsoDone";

const PAGES: { id: SettingsPage; title: string }[] = [
  { id: "look", title: "Look" },
  { id: "notifications", title: "Notifications" },
  { id: "accessibility", title: "Accessibility" },
  { id: "machines", title: "Machines" },
  { id: "storage", title: "Storage" },
  { id: "about", title: "About" },
];

function NotificationsPage() {
  const notifications = computed(() => {
    revision();
    return { needsYou: Herdr.setting(NOTIFY_NEEDS_YOU) === true, alsoDone: Herdr.setting(NOTIFY_ALSO_DONE) === true };
  });
  // Whether the desktop has a notification service: asked when the page opens with notifications on, and when they go on.
  const service = signal<NotificationSupport | undefined>(undefined);
  effect(() => {
    if (notifications().needsYou) untracked(() => void Herdr.notificationSupport().then((s) => service.set(s)));
  });
  const setNotify = (key: string, on: boolean) => {
    try {
      Herdr.setSetting(key, on);
    } catch (e) {
      notify(`Could not save the setting: ${e instanceof Error ? e.message : String(e)}`, { lasting: true });
    }
  };
  return (
    <View>
      <SettingRow
        onPress={() => setNotify(NOTIFY_NEEDS_YOU, !notifications().needsYou)}
        label="Notify me when an agent needs me"
        description="Shows the question and the command in a desktop notification while this window is not in front. Off until you switch it on; nothing leaves this computer."
        control={
          <Switch
            label="Notify me when an agent needs me"
            checked={notifications().needsYou}
            onChange={(on) => setNotify(NOTIFY_NEEDS_YOU, on)}
          />
        }
      />
      <SettingRow
        onPress={() => setNotify(NOTIFY_ALSO_DONE, !notifications().alsoDone)}
        disabled={!notifications().needsYou}
        label="Also when an agent finishes"
        description="A quieter notification when an agent is done and you have not looked yet."
        control={
          <Switch
            label="Also when an agent finishes"
            checked={notifications().alsoDone}
            disabled={!notifications().needsYou}
            onChange={(on) => setNotify(NOTIFY_ALSO_DONE, on)}
          />
        }
      />
      <If when={notifications().needsYou && service() !== undefined && !service()?.available}>
        <SettingRow
          label="No notification service"
          description={`${service()?.detail ?? ""} Notifications will not appear until one is running.`}
        />
      </If>
      <If when={notifications().needsYou && service()?.available === true && !service()?.buttons}>
        <SettingRow
          label="No answer buttons"
          description="Your desktop's notifications cannot show buttons: a click opens the agent instead."
        />
      </If>
      <SettingRow
        label="Answering from a notification"
        description="A button is offered only for a plain answer, never for a risky one or “don't ask again”. It sends only if the agent still shows the same question; otherwise nothing is sent and the notification says so."
      />
    </View>
  );
}

function AccessibilityPage() {
  return (
    <View>
      <SettingRow
        onPress={() => announceOutput.set(!announceOutput())}
        label="Announce agent output"
        description="A screen reader reads new text from the pane you are watching, at most every two seconds. An agent that needs you is always announced."
        control={
          <Switch label="Announce agent output" checked={announceOutput()} onChange={(v) => announceOutput.set(v)} />
        }
      />
      <SettingRow
        onPress={() => reduceMotionOverride.set(!reduceMotionOverride())}
        label="Reduce motion"
        description="Turns off the app's own animations, as your system's setting does. Windows the system draws still follow the system."
        control={
          <Switch
            label="Reduce motion"
            checked={reduceMotionOverride()}
            onChange={(v) => reduceMotionOverride.set(v)}
          />
        }
      />
      <SettingRow
        onPress={() => largeTargets.set(!largeTargets())}
        label="Large hit targets"
        description="44 pt targets for a touch screen. A pointer gets 24 pt targets."
        control={<Switch label="Large hit targets" checked={largeTargets()} onChange={(v) => largeTargets.set(v)} />}
      />
    </View>
  );
}

/**
 * What the app keeps on this computer. The numbers are read when the page opens and after each change here, not on a
 * timer: a copy saved while the page is open shows the next time it opens.
 */
function StoragePage() {
  const usage = signal(Herdr.cacheUsage());
  // Cleared stays said until the person changes something else here; the size line alone would read as a plain zero.
  const cleared = signal(false);
  const attempt = (what: string, run: () => void) => {
    try {
      run();
    } catch (e) {
      notify(`Could not ${what}: ${e instanceof Error ? e.message : String(e)}`, { lasting: true });
    }
    usage.set(Herdr.cacheUsage());
  };
  const setKeep = (on: boolean) =>
    attempt("save the setting", () => {
      Herdr.setCacheEnabled(on);
      cleared.set(false);
    });
  return (
    <View>
      <SettingRow
        onPress={() => setKeep(!usage().enabled)}
        label="Keep conversations and the board on this computer"
        description="Saves the conversations you open and the last state of the board here, so a tab opens at once and then catches up. They stay on this computer, readable only by this account, and a machine's are deleted when you remove the machine. Turning this off keeps what is saved until you clear it."
        control={
          <Switch
            label="Keep conversations and the board on this computer"
            checked={usage().enabled}
            onChange={setKeep}
          />
        }
      />
      <SettingRow
        label={`Saved conversations and boards: ${sizeText(usage().bytes)}`}
        description="Everything the switch above keeps. Clearing deletes it; a conversation is saved again the next time you open it."
        control={
          <Btn
            small
            label={cleared() ? "Cleared" : "Clear"}
            name={cleared() ? "Cleared saved conversations and boards" : "Clear saved conversations and boards"}
            disabled={cleared()}
            onPress={() =>
              attempt("clear the saved copies", () => {
                Herdr.clearCache();
                cleared.set(true);
              })
            }
          />
        }
      />
      <SettingRow
        label={`Copies of files from other machines: ${sizeText(usage().mediaBytes)}`}
        description="Videos and sounds played from another machine, kept so they play again without a second copy. Clear does not remove them."
      />
    </View>
  );
}

function AboutPage() {
  const versions = computed(() => {
    revision();
    const statuses = Herdr.machineStatuses();
    return {
      herdr: statuses.find((s) => s.id === "local")?.herdrVersion ?? undefined,
      newer: statuses.filter((s) => s.newerHerdr).map((s) => s.name),
    };
  });
  // Asked when the page opens, not at launch: nothing leaves the computer unless the person looks at About.
  effect(() => {
    if (settingsReady() && checkUpdates()) untracked(() => void checkForUpdate(app.version));
  });
  return (
    <View>
      <SettingRow label="Herdr Desktop" description={`Version ${app.version}`} />
      <SettingRow label="Core" description={`herdr-core ${Herdr.coreVersion()}`} />
      <SettingRow
        label="herdr on this computer"
        description={versions().herdr ? `Version ${versions().herdr}` : "Not connected"}
      />
      <If when={versions().newer.length > 0}>
        <SettingRow
          label="Newer herdr"
          description={`${versions().newer.join(", ")} runs a newer herdr than this app was written for. It is used as it is.`}
        />
      </If>
      <SettingRow
        onPress={() => checkUpdates.set(!checkUpdates())}
        label="Check for updates"
        description="When this page opens, asks api.github.com for the newest release of Herdr Desktop. Nothing else is sent and nothing is installed."
        control={<Switch label="Check for updates" checked={checkUpdates()} onChange={(v) => checkUpdates.set(v)} />}
      />
      <If when={checkUpdates()}>
        <UpdateRow />
      </If>
    </View>
  );
}

/**
 * What the update check found, said either way (honest: silence would read as up to date): checking, up to date, why it
 * could not tell with a retry, or the newer version with how to get it. Updating is the install script run again, so the
 * row copies that line; the release page has the notes.
 */
function UpdateRow() {
  const check = updateCheck;
  return (
    <If
      when={check().kind === "newer"}
      else={
        <If
          when={check().kind === "failed"}
          else={
            <SettingRow
              label={check().kind === "current" ? "Up to date" : "Checking for updates…"}
              description={check().kind === "current" ? `${app.version} is the newest release.` : undefined}
            />
          }
        >
          <SettingRow
            label="Could not check for updates"
            description={(() => {
              const c = check();
              return c.kind === "failed" ? `${c.reason}.` : "";
            })()}
            control={<Btn small label="Try again" onPress={() => void checkForUpdate(app.version)} />}
          />
        </If>
      }
    >
      <SettingRow
        label="Update available"
        description={(() => {
          const c = check();
          const version = c.kind === "newer" ? c.version : "";
          return `Version ${version} is out; this is ${app.version}. To update, run the install command again in a terminal, then restart the app.`;
        })()}
        control={
          <View class="flex-row gap-2">
            <Btn small label="Copy install command" onPress={() => void copyText(UPDATE_COMMAND, "Install command")} />
            <Btn
              small
              label="Open release page"
              onPress={() => {
                const c = check();
                if (c.kind === "newer") void openUrl(c.url);
              }}
            />
          </View>
        }
      />
    </If>
  );
}

/** One entry of the nav: its page, the current one `selected` (a state, not only colour). */
function NavItem(props: { page: (typeof PAGES)[number] }) {
  const current = () => settingsPage() === props.page.id;
  return (
    <Button
      onPress={() => settingsPage.set(props.page.id)}
      selected={current()}
      accessibilityLabel={props.page.title}
      style={hoverTransition()}
      class={`min-h-8 flex-row items-center gap-3 rounded-md px-3 hover:bg-accent selected:bg-accent ${FOCUS_RING}`}
    >
      <Text class={`text-sm text-foreground ${current() ? "font-medium" : ""}`}>{props.page.title}</Text>
    </Button>
  );
}

/**
 * Every preference of the app, as a large centered dialog over the unchanged window: a nav of pages at the left (Look,
 * Notifications, Accessibility, Machines, Storage, About) and the chosen page's rows beside it, at a readable measure.
 * Each option applies and is saved the moment it changes (`lib/settings.ts`, and the engine's settings file for the
 * notification and storage switches). It is open while `settingsPage()` is set. `Escape` goes one layer back (a
 * machine's form, then the dialog); `Close` and the sidebar's Settings row do the same with the pointer. Opening or
 * closing it answers nothing.
 */
export function Settings() {
  const page = () => PAGES.find((p) => p.id === settingsPage()) ?? PAGES[0];
  return (
    <Modal
      open={settingsPage() !== null}
      size="settings"
      title="Settings"
      disablePointerDismissal={machineForm() !== null}
      onClose={() => {
        if (machineForm()) machineForm.set(null);
        else closeSettings();
      }}
      actions={<Btn variant="ghost" small label="Close" name="Close settings" onPress={() => closeSettings()} />}
    >
      <View class="size-full flex-row">
        <View
          role="navigation"
          accessibilityLabel="Settings sections"
          class="w-52 shrink-0 gap-1 border-r border-border bg-sidebar p-3"
        >
          <Each of={PAGES} key={(p: (typeof PAGES)[number]) => p.id}>
            {(p) => <NavItem page={p()} />}
          </Each>
        </View>
        <Scroll class="min-w-0 flex-1" contentClass="px-8 py-6">
          <View class="w-full gap-4" style={{ maxWidth: DIALOG_LARGE.measure }}>
            <Text role="header" class="text-xl font-medium text-foreground">
              {page().title}
            </Text>
            <If when={page().id === "look"}>
              <LookPage />
            </If>
            <If when={page().id === "notifications"}>
              <NotificationsPage />
            </If>
            <If when={page().id === "accessibility"}>
              <AccessibilityPage />
            </If>
            <If when={page().id === "machines"}>
              <Machines />
            </If>
            <If when={page().id === "storage"}>
              <StoragePage />
            </If>
            <If when={page().id === "about"}>
              <AboutPage />
            </If>
          </View>
        </Scroll>
      </View>
    </Modal>
  );
}
