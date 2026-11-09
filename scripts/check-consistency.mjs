#!/usr/bin/env node
// Consistency ratchet: scans components/ and lib/ for classes that break the ladders in lib/layout.ts and
// design/taste.md (pressable heights, radii, weights, spacing steps, infinite motion, hex colours).
// Build check like check-docs.mjs, not an app test. No dependencies.
//
//   node scripts/check-consistency.mjs            fail on any violation not in scripts/consistency-baseline.json
//   node scripts/check-consistency.mjs --all      also list the baselined ones (the sweep's to-do list)
//   node scripts/check-consistency.mjs --update   rewrite the baseline with what is left; refuses if anything is new
//   node scripts/check-consistency.mjs --init     rewrite the baseline from scratch (first run only)
//
// A baseline key is rule + file + trimmed line text (not the line number: other edits move lines) with a count, so a
// sweep that fixes a line shrinks the baseline and a new copy of an old violation still fails.
//
// Limits (a regex over source text, not a parser):
// - A "pressable" is a line, or the JSX tag that opens within the 8 lines above it, that mentions onPress, Btn,
//   IconButton, Pressable, a Field/Select/Combobox/Tab/Chip, or a class constant named like button/row/chip/input/search/tab.
//   A pressable whose height comes from a class built elsewhere or from a computed string is not seen, and a
//   non-pressable `h-9` on a line that also mentions one of those words is a false positive (baseline it).
// - Arbitrary `h-[Npx]` over 64 and every `max-h-*` are skipped (viewers, list boxes).
// - Only literal classes are read: `${n}` built names, `style={{}}` objects and Rust-side rows are not.
// - Spacing is flagged for gap/p/m/space classes only (w, h, inset and translate may use any step).
// - Hex is flagged in code lines that are not imports or comments; lib/theme/ (the palette itself) is skipped.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const BASELINE = join(root, "scripts/consistency-baseline.json");
const args = new Set(process.argv.slice(2));

const SKIP_FILE = /(\.test\.tsx?|-lab\.tsx?|-probe\.tsx?|\.fixture\.tsx?|^components\/kit\/.*\.test\.tsx?)$/;
const SKIP_DIR = ["lib/theme/"];
// A half step is the segmented track's padding only.
const HALF_STEP_ALLOWED = new Set(["components/kit/segmented.tsx"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // Hidden folders are generated (nsh writes `.nsh/types` beside the entry it last ran), never project code.
    if (statSync(path).isDirectory()) {
      if (!name.startsWith(".")) walk(path, out);
    } else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const PRESSABLE =
  /onPress|<Btn\b|<IconButton\b|<Pressable\b|<(?:Field|SelectField|Combobox|Tab|TabItem|Chip|Segmented)\b|(?:button|btn|row|chip|input|search|tab)\w*\s*[:=]/i;
const OFF_HEIGHT = /(?<![\w-])(?:min-h|h|size)-(5|6|9|10|12|13|14|\[\d+px\])(?![\w.[-])/g;
const ON_LADDER_PX = new Set(["28px", "32px", "44px"]);
const SPACING =
  /(?<![\w-])-?(?:gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(\d+(?:\.\d+)?|\[[^\]]+\])(?![\w.-])/g;
const STEP_OK = new Set(["0", "1", "2", "3", "4", "6", "8", "12", "16", "20", "24"]);

const rules = {
  "pressable-height": (line, ctx) => {
    if (!PRESSABLE.test(ctx())) return [];
    const hits = [];
    for (const m of line.matchAll(OFF_HEIGHT)) {
      // An arbitrary height over 64 is a viewer or a list box, not a control.
      if (m[1].startsWith("[") && (ON_LADDER_PX.has(m[1].slice(1, -1)) || parseInt(m[1].slice(1)) > 64)) continue;
      hits.push(m[0]);
    }
    return hits;
  },
  "bare-rounded": (line) => [...line.matchAll(/(?<![\w-])rounded(?:-\[[^\]]+\])?(?![\w-])/g)].map((m) => m[0]),
  weight: (line) => [...line.matchAll(/(?<![\w-])font-(?:bold|semibold|extrabold|black)(?![\w-])/g)].map((m) => m[0]),
  spacing: (line, _ctx, file) => {
    const hits = [];
    for (const m of line.matchAll(SPACING)) {
      if (m[1] === "0.5" && HALF_STEP_ALLOWED.has(file)) continue;
      if (m[1].startsWith("[") || !STEP_OK.has(m[1])) hits.push(m[0]);
    }
    return hits;
  },
  "infinite-motion": (line) => (/iterations\s*:\s*["']infinite["']/.test(line) ? ["iterations: infinite"] : []),
  "animate-class": (line) => [...line.matchAll(/(?<![\w-])animate-[\w-]+/g)].map((m) => m[0]),
  hex: (line) => {
    const t = line.trim();
    if (/^(import|export \* from|\/\/|\/\*|\*)/.test(t) || /from "#/.test(t)) return [];
    return [...line.matchAll(/(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g)]
      .filter((m) => /["'`(\s:]/.test(line[m.index - 1] ?? " "))
      .map((m) => m[0]);
  },
};

const found = [];
for (const abs of [...walk(join(root, "components")), ...walk(join(root, "lib"))]) {
  const file = relative(root, abs);
  if (SKIP_FILE.test(file) || SKIP_DIR.some((d) => file.startsWith(d))) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    // The opening tag may start up to 8 lines above a class line: stop at the last line that opens a tag.
    const ctx = () => {
      let from = i;
      while (from > 0 && i - from < 8 && !/^\s*<[A-Za-z]/.test(lines[from])) from--;
      return lines.slice(from, i + 1).join(" ");
    };
    for (const [rule, check] of Object.entries(rules))
      for (const hit of check(line, ctx, file)) found.push({ rule, file, line: i + 1, hit, text: line.trim() });
  });
}

const key = (v) => `${v.rule}\t${v.file}\t${v.text}`;
const counts = new Map();
for (const v of found) counts.set(key(v), (counts.get(key(v)) ?? 0) + 1);

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const write = () => {
  const out = {};
  for (const [k, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) out[k] = n;
  writeFileSync(BASELINE, JSON.stringify(out, null, 1) + "\n");
};

const seen = new Map();
const fresh = [];
const old = [];
for (const v of found) {
  const k = key(v);
  const n = (seen.get(k) ?? 0) + 1;
  seen.set(k, n);
  (n <= (baseline[k] ?? 0) ? old : fresh).push(v);
}

const table = (list) => {
  const w = Math.max(...list.map((v) => `${v.file}:${v.line}`.length));
  for (const v of list) console.log(`  ${`${v.file}:${v.line}`.padEnd(w)}  ${v.rule.padEnd(16)} ${v.hit}`);
};

const perRule = {};
for (const v of old) perRule[v.rule] = (perRule[v.rule] ?? 0) + 1;

if (args.has("--init")) {
  write();
  console.log(`baseline written: ${found.length} violations`);
  process.exit(0);
}
if (args.has("--all") && old.length) {
  console.log("baselined (to fix):");
  table(old);
}
if (fresh.length) {
  console.log(`${fresh.length} NEW consistency violation(s) (ladders: lib/layout.ts, rules: design/taste.md):`);
  table(fresh);
  console.log("Fix them. A baseline entry is never added by hand.");
  process.exit(1);
}
const gone = Object.entries(baseline).reduce((n, [k, c]) => n + Math.max(0, c - (counts.get(k) ?? 0)), 0);
if (args.has("--update")) {
  write();
  console.log(`baseline shrunk by ${gone}; ${found.length} left`);
} else {
  const summary =
    Object.entries(perRule)
      .map(([r, n]) => `${r} ${n}`)
      .join(", ") || "none";
  console.log(
    `consistency ok: ${old.length} baselined (${summary})${gone ? `; ${gone} fixed: run --update to shrink the baseline` : ""}`,
  );
}
