import { colorScheme, computed, Text, View } from "nsh";

import { RadioGroup, RadioItem, SelectField, SettingRow, Switch } from "#kit";
import {
  alwaysShowScrollbars,
  codeLineNumbers,
  codeWhitespace,
  codeWrap,
  diffSplit,
  minContrast,
  paneFontSize,
  terminalFontSize,
  terminalOptionAsMeta,
  themeId,
} from "#lib/settings";
import { swatches } from "#lib/theme/build";
import type { ThemeSpec } from "#lib/theme/build";
import { THEMES } from "#lib/theme/themes";

/** 9 to 24 pt, the range `loadSettings` accepts. */
const FONT_SIZES = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 9), title: `${i + 9} pt` }));

/** 10 to 16 pt in steps of 1, the range `loadSettings` accepts for the terminal. */
const TERMINAL_SIZES = Array.from({ length: 7 }, (_, i) => ({ value: String(i + 10), title: `${i + 10} pt` }));

/** 1 (off) to 7 in halves: WCAG's 3 for large text, 4.5 for body text and 7 for the strictest level all fall on it. */
const CONTRASTS = Array.from({ length: 13 }, (_, i) => 1 + i / 2);
const contrastTitle = (n: number) => (n === 1 ? "Off" : n === 4.5 ? "4.5 (recommended)" : String(n));

/** A miniature of the app in a theme: page, sidebar, card, primary and signal, drawn from the theme's own colours. */
function ThemePreview(props: { spec: ThemeSpec }) {
  // One build per preview: `swatches` builds the whole theme, and the preview reads it a dozen times.
  const sw = computed(() => swatches(props.spec, colorScheme()));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      class="h-14 flex-row overflow-hidden rounded-sm border border-border"
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
      <View class="flex-row flex-wrap gap-3">
        <Each of={THEMES} key={(t: ThemeSpec) => t.id}>
          {(spec) => (
            <RadioItem
              value={spec().id}
              label={`${spec().name}: ${spec().blurb}`}
              class="w-28 gap-2 rounded-lg border border-border p-2 hover:bg-accent checked:border-primary"
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

/** The Look page: the theme, scrollbars, the pane's text, and how code and diffs are drawn. */
export function LookPage() {
  const contrasts = computed(() =>
    CONTRASTS.includes(minContrast()) ? CONTRASTS : [...CONTRASTS, minContrast()].sort((a, b) => a - b),
  );
  const fontSizes = computed(() =>
    FONT_SIZES.some((s) => s.value === String(paneFontSize()))
      ? FONT_SIZES
      : [...FONT_SIZES, { value: String(paneFontSize()), title: `${paneFontSize()} pt` }],
  );
  return (
    <View>
      <SettingRow
        label="Theme"
        description="Each theme has a light and a dark form that follow your system."
        stacked
        control={<ThemePicker />}
      />
      <SettingRow
        onPress={() => alwaysShowScrollbars.set(!alwaysShowScrollbars())}
        label="Always show scrollbars"
        description="Keeps the scroll bar visible instead of showing it while you scroll. Turn on if you lose track of how far a list goes."
        control={
          <Switch
            label="Always show scrollbars"
            checked={alwaysShowScrollbars()}
            onChange={(v) => alwaysShowScrollbars.set(v)}
          />
        }
      />
      <SettingRow
        label="Pane font size"
        description="The size a pane's text is drawn at. It is scaled down to fit the pane's columns in the width, never below 9 pt."
        control={
          <View class="w-44">
            <SelectField
              small
              name="Pane font size"
              items={fontSizes()}
              value={String(paneFontSize())}
              onChange={(v) => paneFontSize.set(Number(v))}
            />
          </View>
        }
      />
      <SettingRow
        label="Terminal font size"
        description="The size the terminal's text is drawn at; rows are one and a quarter times it, so box lines stay joined."
        control={
          <View class="w-44">
            <SelectField
              small
              name="Terminal font size"
              items={TERMINAL_SIZES}
              value={String(terminalFontSize())}
              onChange={(v) => terminalFontSize.set(Number(v))}
            />
          </View>
        }
      />
      <SettingRow
        onPress={() => terminalOptionAsMeta.set(!terminalOptionAsMeta())}
        label="Option is Meta in the terminal"
        description="On a Mac, Option+B and Option+F move by word in a shell instead of typing a symbol."
        control={
          <Switch
            label="Option is Meta in the terminal"
            checked={terminalOptionAsMeta()}
            onChange={(v) => terminalOptionAsMeta.set(v)}
          />
        }
      />
      <SettingRow
        label="Minimum contrast"
        description="Lightens or darkens terminal text that is too faint for its background. Off keeps the colours the agent sent."
        control={
          <View class="w-44">
            <SelectField
              small
              name="Minimum contrast"
              items={contrasts().map((n) => ({ value: String(n), title: contrastTitle(n) }))}
              value={String(minContrast())}
              onChange={(v) => minContrast.set(Number(v))}
            />
          </View>
        }
      />
      <SettingRow
        onPress={() => codeWrap.set(!codeWrap())}
        label="Wrap code"
        description="Long lines of code wrap instead of scrolling sideways. Every code block also has a Wrap button."
        control={<Switch label="Wrap code" checked={codeWrap()} onChange={(v) => codeWrap.set(v)} />}
      />
      <SettingRow
        onPress={() => codeLineNumbers.set(!codeLineNumbers())}
        label="Line numbers in code"
        description="A muted number beside every line of code."
        control={
          <Switch label="Line numbers in code" checked={codeLineNumbers()} onChange={(v) => codeLineNumbers.set(v)} />
        }
      />
      <SettingRow
        onPress={() => codeWhitespace.set(!codeWhitespace())}
        label="Show tabs and spaces"
        description="Draws a tab as an arrow and a space at the end of a line as a dot, so a stray one cannot hide."
        control={
          <Switch label="Show tabs and spaces" checked={codeWhitespace()} onChange={(v) => codeWhitespace.set(v)} />
        }
      />
      <SettingRow
        onPress={() => diffSplit.set(!diffSplit())}
        label="Diffs side by side"
        description="Old text on the left and new on the right, instead of one column."
        control={<Switch label="Diffs side by side" checked={diffSplit()} onChange={(v) => diffSplit.set(v)} />}
      />
    </View>
  );
}
