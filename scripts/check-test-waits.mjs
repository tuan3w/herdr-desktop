#!/usr/bin/env node
// Test-wait ratchet: scans the TSX tests for the two patterns that made headless tests pass or fail with the machine's
// load (`.agents/skills/herdr-test/SKILL.md`, section 5). Build check like check-consistency.mjs, not an app test.
//
//   node scripts/check-test-waits.mjs            fail on any violation not in scripts/test-waits-baseline.json
//   node scripts/check-test-waits.mjs --all      also list the baselined ones (the sweep's to-do list)
//   node scripts/check-test-waits.mjs --update   rewrite the baseline with what is left; refuses if anything is new
//   node scripts/check-test-waits.mjs --init     rewrite the baseline from scratch (first run only)
//
// Rules:
// - `assert-after-action`: `expect(<view>.shows(..)).toBe(true)` (or `shown(..)`) right after a step that makes it
//   appear: a press, a key, a step of the clock, an open. What appears comes from real-time work (a pane read, a git
//   read, a log read, the board loading, a terminal mounting) and the clock's step does not wait for it: the line
//   passes alone and fails under load. Wait for the fact (`waitFor`, `waitUntil`, `pressSettled`) and assert after.
// - `order-from-texts`: an index into `app.texts()`. The texts of a list are in the order its recycled cells were made,
//   not the screen's, so an order read from them differs from run to run; read it from the model.
//
// Limits (a regex over source text): only the previous statement is looked at, so a wait two lines up is not seen
// (put the wait next to the assertion, which is where a reader looks), and an `expect(...).toBe(false)` is never
// flagged: absence right after an action is checked after a positive wait, which is the test's business.
// A baseline key is rule + file + trimmed line text with a count, so a fix shrinks the baseline and a new copy fails.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const BASELINE = join(root, "scripts/test-waits-baseline.json");
const args = new Set(process.argv.slice(2));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!name.startsWith(".") && name !== "node_modules" && name !== "target") walk(path, out);
    } else if (name.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

const ASSERT_SHOWN = /^\s*expect\((?:\w+\.shows\(|shown\()[^;]*\)\)\.toBe\(true\);/;
const ACTION =
  /(?:\.press\(|\.keyboard\.press\(|\.clock!?\.runFor\(|\.type\(|openAgents\(|openTerminals\(|settle\(|pressSettled\()/;
const ORDER = /\.texts\(\)\.indexOf\(|\btexts\.indexOf\(/;

/** The statement before line `i`: the nearest earlier line that is not blank and not a comment. */
function previous(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) return t;
  }
  return "";
}

const rules = {
  "assert-after-action": (lines, i) =>
    ASSERT_SHOWN.test(lines[i]) && ACTION.test(previous(lines, i)) ? [lines[i]] : [],
  "order-from-texts": (lines, i) => (ORDER.test(lines[i]) ? [lines[i]] : []),
};

const found = [];
for (const file of walk(root).sort()) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [rule, check] of Object.entries(rules)) {
      for (const text of check(lines, i))
        found.push({ key: `${rule}\t${rel}\t${text.trim()}`, rule, rel, line: i + 1 });
    }
  }
}

const counts = new Map();
for (const f of found) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const seen = new Map();
const fresh = [];
const old = [];
for (const f of found) {
  const n = (seen.get(f.key) ?? 0) + 1;
  seen.set(f.key, n);
  (n <= (baseline[f.key] ?? 0) ? old : fresh).push(f);
}
const write = () => {
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
};

if (args.has("--init")) {
  write();
  console.log(`baseline written: ${found.length} violations`);
  process.exit(0);
}
if (args.has("--all") && old.length) {
  console.log("baselined (to fix):");
  for (const f of old) console.log(`  ${f.rule}  ${f.rel}:${f.line}`);
}
if (fresh.length) {
  console.log("test-waits: new violations:");
  for (const f of fresh) console.log(`  ${f.rule}  ${f.rel}:${f.line}  ${f.key.split("\t")[2]}`);
  console.log(
    "Wait for the fact the line asserts (waitFor, waitUntil, pressSettled) and assert after it; read an order from the model, not from texts(). A baseline entry is never added by hand.",
  );
  process.exit(1);
}
const gone = Object.entries(baseline).reduce((n, [k, c]) => n + Math.max(0, c - (counts.get(k) ?? 0)), 0);
if (args.has("--update")) {
  write();
  console.log(`baseline shrunk by ${gone}; ${found.length} left`);
  process.exit(0);
}
console.log(
  `test-waits ok: ${old.length} baselined${gone ? `; ${gone} fixed: run --update to shrink the baseline` : ""}`,
);
