// Writes theme.json (nsh.json's "theme": the theme the app starts in) from the default theme's spec.
// Run: bun scripts/gen-theme.mjs   -- `lib/theme/theme.test.ts` fails when theme.json and the generator disagree.
import { themeFile } from "../lib/theme/build.ts";
import { DEFAULT_THEME_ID, themeById } from "../lib/theme/themes.ts";

await Bun.write("theme.json", `${JSON.stringify(themeFile(themeById(DEFAULT_THEME_ID)), null, 2)}\n`);
console.log(`theme.json <- ${DEFAULT_THEME_ID}`);
