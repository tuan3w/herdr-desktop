import { Herdr } from "herdr-desktop/native";
import { colorScheme, computed, effect, openUrl, signal, Text, untracked, View } from "nsh";

import type { NotificationSupport } from "herdr-desktop/native";

import { Machines } from "#components/machines";
import { Btn, Modal, notify, RadioGroup, RadioItem, SelectField, SettingRow, SettingsSection, Switch } from "#kit";
import { revision } from "#lib/herdr";
import {
  announceOutput,
  checkUpdates,
  codeLineNumbers,
  codeWhitespace,
  codeWrap,
  diffSplit,
  largeTargets,
  minContrast,
  paneFontSize,
  reduceMotionOverride,
  settingsReady,
  themeId,
} from "#lib/settings";
import { swatches } from "#lib/theme/build";
import type { ThemeSpec } from "#lib/theme/build";
import { THEMES } from "#lib/theme/themes";
import { availableUpdate, checkForUpdate } from "#lib/updates";

import app from "../nsh.json";

/** The engine's settings keys of the two notification switches (`native/app/src/engine/alerts.rs`). */
const NOTIFY_NEEDS_YOU = "notify.needsYou";
const NOTIFY_ALSO_DONE = "notify.alsoDone";

/** 9 to 24 pt, the range `loadSettings` accepts. */
const FONT_SIZES = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 9), title: `${i + 9} pt` }));

/** 1 (off) to 7 in halves: WCAG's 3 for large text, 4.5 for body text and 7 for the strictest level all fall on it. */
const CONTRASTS = Array.from({ length: 13 }, (_, i) => 1 + i / 2);
const contrastTitle = (n: number) => (n === 1 ? "Off" : n === 4.5 ? "4.5 (recommended)" : String(n));

/** A miniature of the app in a theme: page, sidebar, card, primary and signal, drawn from the theme's own colours. */
function ThemePreview(props: { spec: ThemeSpec }) {
  const sw = () => swatches(props.spec, colorScheme());
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      class="h-14 flex-row overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: sw().page }}
    >
      <View class="w-8 gap-2 p-2" style={{ backgroundColor: sw().sidebar }}>
        <View class="h-1.5 w-full rounded-full" style={{ backgroundColor: sw().signal }} />
        <View class="h-1 w-full rounded-full opacity-40" style={{ backgroundColor: sw().page }} />
        <View class="h-1 w-3/4 rounded-full opacity-40" style={{ backgroundColor: sw().page }} />
      </View>
      <View class="flex-1 gap-2 p-2">
        <View class="h-1.5 w-10 rounded-full" style={{ backgroundColor: sw().ink }} />
        <View class="flex-1 justify-end rounded-sm p-2" style={{ backgroundColor: sw().card }}>
          <View class="h-2.5 w-9 rounded-sm" style={{ backgroundColor: sw().primary }} />
        </View>
      </View>
    </View>
  );
}

/** All the themes in one row, each a miniature and its name; the chosen one's blurb is read under the row. */
function ThemePicker() {
  return (
    <RadioGroup value={themeId()} onChange={(id) => themeId.set(id)} label="Theme" class="gap-3">
      <View class="flex-row gap-3">
        <Each of={THEMES} key={(t: ThemeSpec) => t.id}>
          {(spec) => (
            <RadioItem
              value={spec().id}
              label={`${spec().name}: ${spec().blurb}`}
              class="min-w-0 flex-1 gap-2 rounded-lg border border-border bg-background p-2 hover:bg-accent checked:border-primary checked:bg-accent"
            >
              <ThemePreview spec={spec()} />
              <Text class="px-1 text-sm font-medium text-foreground">{spec().name}</Text>
            </RadioItem>
          )}
        </Each>
      </View>
      <Text class="text-sm text-muted-foreground">{THEMES.find((t) => t.id === themeId())?.blurb ?? ""}</Text>
    </RadioGroup>
  );
}

/**
 * Every preference of the app, applied and saved the moment it changes (`lib/settings.ts`, and the engine's settings file for the
 * notification switches): Look, Agents, Notifications, Accessibility, the Machines list, and About (version, herdr's version, and
 * the update check).
 */
export function Settings(props: { open: boolean; onClose: () => void }) {
  const machines = signal(false);
  const versions = computed(() => {
    revision();
    const statuses = Herdr.machineStatuses();
    return {
      herdr: statuses.find((s) => s.id === "local")?.herdrVersion ?? undefined,
      newer: statuses.filter((s) => s.newerHerdr).map((s) => s.name),
    };
  });
  const contrasts = computed(() =>
    CONTRASTS.includes(minContrast()) ? CONTRASTS : [...CONTRASTS, minContrast()].sort((a, b) => a - b),
  );
  const fontSizes = computed(() =>
    FONT_SIZES.some((s) => s.value === String(paneFontSize()))
      ? FONT_SIZES
      : [...FONT_SIZES, { value: String(paneFontSize()), title: `${paneFontSize()} pt` }],
  );
  // Whether the desktop has a notification service: asked when Settings opens with notifications on, and when they go on.
  const service = signal<NotificationSupport | undefined>(undefined);
  const notifications = computed(() => {
    revision();
    return { needsYou: Herdr.setting(NOTIFY_NEEDS_YOU) === true, alsoDone: Herdr.setting(NOTIFY_ALSO_DONE) === true };
  });
  effect(() => {
    if (props.open && notifications().needsYou)
      untracked(() => void Herdr.notificationSupport().then((s) => service.set(s)));
  });
  const setNotify = (key: string, on: boolean) => {
    try {
      Herdr.setSetting(key, on);
    } catch (e) {
      notify(`Could not save the setting: ${e instanceof Error ? e.message : String(e)}`, { lasting: true });
    }
  };
  // Asked when the window opens, not at launch: nothing leaves the computer unless the person looks at Settings.
  effect(() => {
    if (props.open && settingsReady() && checkUpdates()) untracked(() => void checkForUpdate(app.version));
  });

  return (
    <>
      <Modal
        open={props.open}
        onClose={() => props.onClose()}
        title="Settings"
        wide
        actions={<Btn variant="primary" label="Done" onPress={() => props.onClose()} />}
      >
        <View class="gap-8">
          <SettingsSection title="Look">
            <SettingRow
              label="Theme"
              description="Each theme has a light and a dark form that follow your system."
              stacked
              control={<ThemePicker />}
            />
            <SettingRow
              label="Pane font size"
              description="The size a pane's text is drawn at. It is scaled down to fit the pane's columns in the width, never below 9 pt."
              control={
                <SelectField
                  small
                  name="Pane font size"
                  items={fontSizes()}
                  value={String(paneFontSize())}
                  onChange={(v) => paneFontSize.set(Number(v))}
                />
              }
            />
            <SettingRow
              label="Minimum contrast"
              description="Lightens or darkens terminal text that is too faint for its background. Off keeps the colours the agent sent."
              control={
                <SelectField
                  small
                  name="Minimum contrast"
                  items={contrasts().map((n) => ({ value: String(n), title: contrastTitle(n) }))}
                  value={String(minContrast())}
                  onChange={(v) => minContrast.set(Number(v))}
                />
              }
            />
            <SettingRow
              label="Wrap code"
              description="Long lines of code wrap instead of scrolling sideways. Every code block also has a Wrap button."
              control={<Switch label="Wrap code" checked={codeWrap()} onChange={(v) => codeWrap.set(v)} />}
            />
            <SettingRow
              label="Line numbers in code"
              description="A muted number beside every line of code."
              control={
                <Switch
                  label="Line numbers in code"
                  checked={codeLineNumbers()}
                  onChange={(v) => codeLineNumbers.set(v)}
                />
              }
            />
            <SettingRow
              label="Show tabs and spaces"
              description="Draws a tab as an arrow and a space at the end of a line as a dot, so a stray one cannot hide."
              control={
                <Switch
                  label="Show tabs and spaces"
                  checked={codeWhitespace()}
                  onChange={(v) => codeWhitespace.set(v)}
                />
              }
            />
            <SettingRow
              label="Diffs side by side"
              description="Old text on the left and new on the right, instead of one column."
              control={<Switch label="Diffs side by side" checked={diffSplit()} onChange={(v) => diffSplit.set(v)} />}
            />
          </SettingsSection>
          <SettingsSection title="Notifications">
            <SettingRow
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
          </SettingsSection>
          <SettingsSection title="Accessibility">
            <SettingRow
              label="Announce agent output"
              description="A screen reader reads new text from the pane you are watching, at most every two seconds. An agent that needs you is always announced."
              control={
                <Switch
                  label="Announce agent output"
                  checked={announceOutput()}
                  onChange={(v) => announceOutput.set(v)}
                />
              }
            />
            <SettingRow
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
              label="Large hit targets"
              description="44 pt targets for a touch screen. A pointer gets 24 pt targets."
              control={
                <Switch label="Large hit targets" checked={largeTargets()} onChange={(v) => largeTargets.set(v)} />
              }
            />
          </SettingsSection>
          <SettingsSection title="Machines">
            <SettingRow
              label="Machines"
              description="This computer and the others reached over ssh."
              control={<Btn small label="Manage machines…" name="Manage machines" onPress={() => machines.set(true)} />}
            />
          </SettingsSection>
          <SettingsSection title="About">
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
              label="Check for updates"
              description="When Settings opens, asks api.github.com for the newest release of Herdr Desktop. Nothing else is sent and nothing is installed."
              control={
                <Switch label="Check for updates" checked={checkUpdates()} onChange={(v) => checkUpdates.set(v)} />
              }
            />
            <If when={checkUpdates() && availableUpdate() !== null}>
              <SettingRow
                label="Update available"
                description={`Version ${availableUpdate()?.version} is out. This is ${app.version}.`}
                control={
                  <Btn small label="Open release page" onPress={() => void openUrl(availableUpdate()?.url ?? "")} />
                }
              />
            </If>
          </SettingsSection>
        </View>
      </Modal>
      <Machines open={machines()} onClose={() => machines.set(false)} />
    </>
  );
}
