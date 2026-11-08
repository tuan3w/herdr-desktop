import { Herdr } from "herdr-desktop/native";
import { computed, effect, openUrl, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { NotificationSupport } from "herdr-desktop/native";

import { Machines, machineForm } from "#components/machines";
import { LookPage } from "#components/settings-look";
import { Btn, FOCUS_RING, Modal, notify, SettingRow, Switch } from "#kit";
import { closeSettings, settingsPage } from "#lib/actions";
import type { SettingsPage } from "#lib/actions";
import { revision } from "#lib/herdr";
import { DIALOG_LARGE } from "#lib/layout";
import { hoverTransition } from "#lib/motion";
import { announceOutput, checkUpdates, largeTargets, reduceMotionOverride, settingsReady } from "#lib/settings";
import { availableUpdate, checkForUpdate } from "#lib/updates";

import app from "../nsh.json";

/** The engine's settings keys of the two notification switches (`native/app/src/engine/alerts.rs`). */
const NOTIFY_NEEDS_YOU = "notify.needsYou";
const NOTIFY_ALSO_DONE = "notify.alsoDone";

const PAGES: { id: SettingsPage; title: string }[] = [
  { id: "look", title: "Look" },
  { id: "notifications", title: "Notifications" },
  { id: "accessibility", title: "Accessibility" },
  { id: "machines", title: "Machines" },
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
      <If when={checkUpdates() && availableUpdate() !== null}>
        <SettingRow
          label="Update available"
          description={`Version ${availableUpdate()?.version} is out. This is ${app.version}.`}
          control={<Btn small label="Open release page" onPress={() => void openUrl(availableUpdate()?.url ?? "")} />}
        />
      </If>
    </View>
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
      <Text class="text-sm text-foreground">{props.page.title}</Text>
    </Button>
  );
}

/**
 * Every preference of the app, as a large centered dialog over the unchanged window: a nav of pages at the left (Look,
 * Notifications, Accessibility, Machines, About) and the chosen page's rows beside it, at a readable measure. Each option
 * applies and is saved the moment it changes (`lib/settings.ts`, and the engine's settings file for the notification
 * switches). It is open while `settingsPage()` is set. `Escape` goes one layer back (a machine's form, then the dialog);
 * `Close` and the sidebar's Settings row do the same with the pointer. Opening or closing it answers nothing.
 */
export function Settings() {
  const page = () => PAGES.find((p) => p.id === settingsPage()) ?? PAGES[0];
  return (
    <Modal
      open={settingsPage() !== null}
      size="settings"
      title="Settings"
      disablePointerDismissal
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
            <If when={page().id === "about"}>
              <AboutPage />
            </If>
          </View>
        </Scroll>
      </View>
    </Modal>
  );
}
