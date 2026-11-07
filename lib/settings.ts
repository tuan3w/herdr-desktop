import { computed, effect, signal, Storage } from "nsh";
import { save } from "#lib/save";
import { themeFile } from "#lib/theme/build";
import { DEFAULT_THEME_ID, THEMES, themeById } from "#lib/theme/themes";

/**
 * UI-only preferences, persisted in `Storage` (domain data lives in Rust). To add an option: a signal here with its
 * default, a line in `Saved` and in `loadSettings`, and an entry in Settings.
 */
const KEY = "herdr.settings.v1";

export const themeId = signal(DEFAULT_THEME_ID);
/** Keep the sidebar as an icon rail even in a wide window. */
export const sidebarCollapsed = signal(false);
/** How the pane mirror fits its columns: the whole width, the font as set, or soft-wrapped lines. */
export type PaneFit = "width" | "actual" | "wrap";

export const paneFit = signal<PaneFit>("width");
/** Pane font size in points (the mirror scales it down for `fit` width). */
export const paneFontSize = signal(13);
/** Minimum contrast of terminal text against its background, 1 (off) to 7. */
export const minContrast = signal(4.5);
/** Announce new agent output politely to a screen reader (off: only "needs you" is announced). */
export const announceOutput = signal(false);
/** Learn and show quick phrases above an empty composer. */
export const quickPhrases = signal(true);
/** Larger hit targets (44 pt) for touch screens; pointer targets are 24 pt. */
export const largeTargets = signal(false);
/** Reduce motion regardless of the system setting. */
export const reduceMotionOverride = signal(false);
/** Ask GitHub for a newer release when Settings opens (`lib/updates.ts`). On by default: the request is all that leaves the computer. */
export const checkUpdates = signal(true);
/** Wrap long lines of code instead of scrolling sideways (`components/code-block.tsx`). */
export const codeWrap = signal(false);
/** Line numbers in a muted gutter beside code. */
export const codeLineNumbers = signal(false);
/** Tabs as `→` and trailing spaces as `·` in code. */
export const codeWhitespace = signal(false);
/** Diffs side by side (old left, new right) instead of one column. */
export const diffSplit = signal(false);
export const settingsReady = signal(false);

interface Saved {
  themeId: string;
  sidebarCollapsed: boolean;
  paneFit: PaneFit;
  paneFontSize: number;
  minContrast: number;
  announceOutput: boolean;
  quickPhrases: boolean;
  largeTargets: boolean;
  reduceMotionOverride: boolean;
  checkUpdates: boolean;
  codeWrap: boolean;
  codeLineNumbers: boolean;
  codeWhitespace: boolean;
  diffSplit: boolean;
}

export async function loadSettings(): Promise<void> {
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Saved>;
      if (THEMES.some((t) => t.id === saved.themeId)) themeId.set(saved.themeId!);
      if (typeof saved.sidebarCollapsed === "boolean") sidebarCollapsed.set(saved.sidebarCollapsed);
      if (saved.paneFit === "width" || saved.paneFit === "actual" || saved.paneFit === "wrap") paneFit.set(saved.paneFit);
      if (typeof saved.paneFontSize === "number" && saved.paneFontSize >= 9 && saved.paneFontSize <= 24) paneFontSize.set(saved.paneFontSize);
      if (typeof saved.minContrast === "number" && saved.minContrast >= 1 && saved.minContrast <= 7) minContrast.set(saved.minContrast);
      if (typeof saved.announceOutput === "boolean") announceOutput.set(saved.announceOutput);
      if (typeof saved.quickPhrases === "boolean") quickPhrases.set(saved.quickPhrases);
      if (typeof saved.largeTargets === "boolean") largeTargets.set(saved.largeTargets);
      if (typeof saved.reduceMotionOverride === "boolean") reduceMotionOverride.set(saved.reduceMotionOverride);
      if (typeof saved.checkUpdates === "boolean") checkUpdates.set(saved.checkUpdates);
      if (typeof saved.codeWrap === "boolean") codeWrap.set(saved.codeWrap);
      if (typeof saved.codeLineNumbers === "boolean") codeLineNumbers.set(saved.codeLineNumbers);
      if (typeof saved.codeWhitespace === "boolean") codeWhitespace.set(saved.codeWhitespace);
      if (typeof saved.diffSplit === "boolean") diffSplit.set(saved.diffSplit);
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read settings", e);
  }
  settingsReady.set(true);
}

effect(() => {
  if (!settingsReady()) return;
  const saved: Saved = {
    themeId: themeId(),
    sidebarCollapsed: sidebarCollapsed(),
    paneFit: paneFit(),
    paneFontSize: paneFontSize(),
    minContrast: minContrast(),
    announceOutput: announceOutput(),
    quickPhrases: quickPhrases(),
    largeTargets: largeTargets(),
    reduceMotionOverride: reduceMotionOverride(),
    checkUpdates: checkUpdates(),
    codeWrap: codeWrap(),
    codeLineNumbers: codeLineNumbers(),
    codeWhitespace: codeWhitespace(),
    diffSplit: diffSplit(),
  };
  save(KEY, JSON.stringify(saved));
});

const json = new Map<string, string>();

/** The current theme as nsh reads it (shadcn `cssVars`), for the root's `uiTheme`. Built once per theme. */
export const themeJson = computed(() => {
  const spec = themeById(themeId());
  let text = json.get(spec.id);
  if (!text) {
    text = JSON.stringify(themeFile(spec));
    json.set(spec.id, text);
  }
  return text;
});
