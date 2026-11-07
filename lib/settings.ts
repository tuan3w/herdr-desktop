import { computed, effect, signal, Storage } from "nsh";
import { save } from "./save";
import { themeFile } from "./theme/build";
import { DEFAULT_THEME_ID, THEMES, themeById } from "./theme/themes";

/**
 * UI-only preferences, persisted in `Storage` (domain data lives in Rust). To add an option: a signal here with its
 * default, a line in `Saved` and in `loadSettings`, and an entry in Settings.
 */
const KEY = "herdr.settings.v1";

export const themeId = signal(DEFAULT_THEME_ID);
/** Keep the sidebar as an icon rail even in a wide window. */
export const sidebarCollapsed = signal(false);
export const settingsReady = signal(false);

interface Saved {
  themeId: string;
  sidebarCollapsed: boolean;
}

export async function loadSettings(): Promise<void> {
  try {
    const raw = await Storage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Saved>;
      if (THEMES.some((t) => t.id === saved.themeId)) themeId.set(saved.themeId!);
      if (typeof saved.sidebarCollapsed === "boolean") sidebarCollapsed.set(saved.sidebarCollapsed);
    }
  } catch (e) {
    console.error("herdr-desktop: cannot read settings", e);
  }
  settingsReady.set(true);
}

effect(() => {
  if (!settingsReady()) return;
  const saved: Saved = { themeId: themeId(), sidebarCollapsed: sidebarCollapsed() };
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
