import { colorScheme, computed, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import app from "../nsh.json";
import { revision } from "../lib/herdr";
import type { PaneFit } from "../lib/settings";
import { announceOutput, largeTargets, minContrast, paneFit, paneFontSize, quickPhrases, reduceMotionOverride, themeId } from "../lib/settings";
import { swatches } from "../lib/theme/build";
import type { ThemeSpec } from "../lib/theme/build";
import { THEMES } from "../lib/theme/themes";
import { Machines } from "./machines";
import { Btn, Modal, RadioGroup, RadioItem, Segmented, type SegmentOption, SelectField, SettingRow, SettingsSection, Switch } from "./kit";

const FIT_OPTIONS: SegmentOption<PaneFit>[] = [
  { value: "width", label: "Fit width" },
  { value: "actual", label: "Actual size" },
  { value: "wrap", label: "Wrap lines" },
];

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
      <View class="w-8 gap-1.5 p-1.5" style={{ backgroundColor: sw().sidebar }}>
        <View class="h-1.5 w-full rounded-full" style={{ backgroundColor: sw().signal }} />
        <View class="h-1 w-full rounded-full opacity-40" style={{ backgroundColor: sw().page }} />
        <View class="h-1 w-3/4 rounded-full opacity-40" style={{ backgroundColor: sw().page }} />
      </View>
      <View class="flex-1 gap-1.5 p-2">
        <View class="h-1.5 w-10 rounded-full" style={{ backgroundColor: sw().ink }} />
        <View class="flex-1 justify-end rounded-sm p-1.5" style={{ backgroundColor: sw().card }}>
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
              <Text class="px-0.5 text-sm font-medium text-foreground">{spec().name}</Text>
            </RadioItem>
          )}
        </Each>
      </View>
      <Text class="text-sm text-muted-foreground">{THEMES.find((t) => t.id === themeId())?.blurb ?? ""}</Text>
    </RadioGroup>
  );
}

/**
 * Every preference of the app, applied and saved the moment it changes (`lib/settings.ts`): Look, Agents, Accessibility,
 * the Machines list, and About. Notifications and updates are not here yet because their features are not.
 */
export function Settings(props: { open: boolean; onClose: () => void }) {
  const machines = signal(false);
  const versions = computed(() => {
    revision();
    const statuses = Herdr.machineStatuses();
    return { herdr: statuses.find((s) => s.id === "local")?.herdrVersion ?? undefined, newer: statuses.filter((s) => s.newerHerdr).map((s) => s.name) };
  });
  const contrasts = computed(() => (CONTRASTS.includes(minContrast()) ? CONTRASTS : [...CONTRASTS, minContrast()].sort((a, b) => a - b)));
  const fontSizes = computed(() => (FONT_SIZES.some((s) => s.value === String(paneFontSize())) ? FONT_SIZES : [...FONT_SIZES, { value: String(paneFontSize()), title: `${paneFontSize()} pt` }]));

  return (
    <>
      <Modal open={props.open} onClose={() => props.onClose()} title="Settings" wide actions={<Btn variant="primary" label="Done" onPress={() => props.onClose()} />}>
        <View class="gap-8">
          <SettingsSection title="Look">
            <SettingRow label="Theme" description="Each theme has a light and a dark form that follow your system." stacked control={<ThemePicker />} />
            <SettingRow
              label="Pane width"
              description="How a pane's columns meet the window: scaled to fill the width, the font as set, or lines wrapped to fit."
              control={<Segmented label="Pane width" value={paneFit()} onChange={(v) => paneFit.set(v)} options={FIT_OPTIONS} />}
            />
            <SettingRow
              label="Pane font size"
              description="The size terminal text is drawn at. Fit width scales it down to fit the columns, never below 9 pt."
              control={<SelectField small name="Pane font size" items={fontSizes()} value={String(paneFontSize())} onChange={(v) => paneFontSize.set(Number(v))} />}
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
          </SettingsSection>
          <SettingsSection title="Agents">
            <SettingRow
              label="Quick phrases"
              description="Learns the replies you send often and offers them above an empty composer. Stays on this computer."
              control={<Switch label="Quick phrases" checked={quickPhrases()} onChange={(v) => quickPhrases.set(v)} />}
            />
          </SettingsSection>
          <SettingsSection title="Accessibility">
            <SettingRow
              label="Announce agent output"
              description="A screen reader reads new text from the pane you are watching, at most every two seconds. An agent that needs you is always announced."
              control={<Switch label="Announce agent output" checked={announceOutput()} onChange={(v) => announceOutput.set(v)} />}
            />
            <SettingRow
              label="Reduce motion"
              description="Turns off the app's own animations, as your system's setting does. Windows the system draws still follow the system."
              control={<Switch label="Reduce motion" checked={reduceMotionOverride()} onChange={(v) => reduceMotionOverride.set(v)} />}
            />
            <SettingRow
              label="Large hit targets"
              description="44 pt targets for a touch screen. A pointer gets 24 pt targets."
              control={<Switch label="Large hit targets" checked={largeTargets()} onChange={(v) => largeTargets.set(v)} />}
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
              <SettingRow label="Newer herdr" description={`${versions().newer.join(", ")} runs a newer herdr than this app was written for. It is used as it is.`} />
            </If>
          </SettingsSection>
        </View>
      </Modal>
      <Machines open={machines()} onClose={() => machines.set(false)} />
    </>
  );
}
