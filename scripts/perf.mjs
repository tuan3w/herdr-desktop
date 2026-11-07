// Runs `.perf/scenarios.test.tsx` (or the file you name) in a real GTK window with nsh's monitor on (`--fps`), reads the
// monitor's one line a second (frame rate, main-thread time per frame, JS and core time per commit, CPU, memory) and prints
// one row per scenario.
//
//   bun scripts/perf.mjs            # the table
//   bun scripts/perf.mjs --check    # also exit 1 when a budget of .perf/budgets.json (else the defaults) is broken
//
// On a display (DISPLAY or WAYLAND_DISPLAY set) the numbers are the GPU's; without one the run is under Xvfb with the cairo
// renderer, which is CPU-rendered, so frame times are an upper bound and only counts and ratios carry over. The monitor
// logs a line only while GTK draws frames: an idle scenario prints none, which is the behaviour to keep ("an app at rest
// draws no frames"), and its row says `0 s drawn`.
import { existsSync, readFileSync } from "node:fs";
import { nshTest, realDisplay } from "./run-linux.mjs";

const DEFAULTS = {
  /** Main-thread time per frame, 95th percentile (ms): one refresh at 120 Hz. */
  frameP95: 8.3,
  /** Share of frames that took longer than one refresh (%). */
  over: 10,
  /** Our JS per commit, 95th percentile (ms): a keystroke or a press must not feel slow. */
  jsP95: 50,
  /** Resident memory (MB). */
  memMB: 400,
};
const budgetFile = new URL("../.perf/budgets.json", import.meta.url).pathname;
const BUDGET = { ...DEFAULTS, ...(existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")).default ?? {} : {}) };

const check = process.argv.includes("--check");
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".perf/scenarios.test.tsx";
const run = Bun.spawn(["sh", "-c", `${nshTest(file, "--fps -v")} 2>&1`], { stdout: "pipe" });
const output = await new Response(run.stdout).text();
await run.exited;

// One monitor line: `nsh::perf fps 39/60 frame mean/p50/p95/max gap ... over 3% update ... layout ... paint ... snapshot ...
// canvas ... drain ... commits 5 js m/p50/p95/max core m/p50/p95/max items 137 engine 6% cpu 4% rss 316.3 MB` (`cpu -` on the
// first reading). Only the named groups are used.
const NUMS = "[\\d./]+";
const PERF = new RegExp(
  `nsh::perf fps (?<fps>\\d+)/\\d+ frame [\\d.]+/[\\d.]+/(?<frameP95>[\\d.]+)/[\\d.]+ gap ${NUMS} over (?<over>\\d+)% update ${NUMS} layout ${NUMS} paint ${NUMS} snapshot ${NUMS} canvas ${NUMS} drain ${NUMS} commits (?<commits>\\d+) js [\\d.]+/[\\d.]+/(?<jsP95>[\\d.]+)/[\\d.]+ core [\\d.]+/[\\d.]+/(?<coreP95>[\\d.]+)/[\\d.]+ items \\d+ engine \\d+% cpu (?<cpu>\\d+|-)%? rss (?<mem>[\\d.]+) MB`,
);

const rows = [];
let current = null;
/** The rolling figures of the previous reading: one that has not moved is the same window again, not a new second. */
const previous = { frameP95: "", over: "", jsP95: "", coreP95: "" };
for (const line of output.split("\n")) {
  const marker = line.match(/PERF-SCENARIO (.+)$/);
  if (marker) {
    current = { name: marker[1].trim(), seconds: 0, cpuSeconds: 0, fpsMin: Infinity, frameP95: 0, over: 0, jsP95: 0, coreP95: 0, cpuSum: 0, cpuMax: 0, memMB: 0 };
    rows.push(current);
    continue;
  }
  const g = current && line.match(PERF)?.groups;
  if (!g) continue;
  current.seconds++;
  current.fpsMin = Math.min(current.fpsMin, Number(g.fps));
  // Frame, JS and core figures are windows over recent frames and commits: each counts toward a scenario only when it
  // differs from the reading before it, or a spike would be blamed on every scenario after it.
  const fresh = (key) => g[key] !== previous[key];
  if (fresh("frameP95")) current.frameP95 = Math.max(current.frameP95, Number(g.frameP95));
  if (fresh("over")) current.over = Math.max(current.over, Number(g.over));
  if (fresh("jsP95") && Number(g.commits) > 0) current.jsP95 = Math.max(current.jsP95, Number(g.jsP95));
  if (fresh("coreP95") && Number(g.commits) > 0) current.coreP95 = Math.max(current.coreP95, Number(g.coreP95));
  for (const key of Object.keys(previous)) previous[key] = g[key];
  if (g.cpu !== "-") {
    current.cpuSeconds++;
    current.cpuSum += Number(g.cpu);
    current.cpuMax = Math.max(current.cpuMax, Number(g.cpu));
  }
  current.memMB = Math.max(current.memMB, Number(g.mem));
}

// A scenario that throws ends the run: the table would then be partial, which must not pass for a result.
const lines = output.split("\n");
const failedAt = lines.findIndex((l) => l.includes("✗"));
const failure = failedAt >= 0 ? lines.slice(failedAt, failedAt + 2).join("\n") : "";

if (rows.length === 0) {
  console.error("No scenario ran: does the file print PERF-SCENARIO markers?\n" + lines.slice(-15).join("\n"));
  process.exit(2);
}

const header = ["scenario", "s drawn", "fps min", "frame p95", "over %", "js p95", "core p95", "cpu avg/max", "rss MB"];
const broken = [];
/** The text of a cell, with `!` after it when `value` is over `limit`; the breach is noted for the summary. */
const limited = (row, column, value, limit, text) => {
  if (value <= limit) return text;
  broken.push(`${row.name}: ${column} ${text}`);
  return `${text}!`;
};
const body = rows.map((r) =>
  r.seconds === 0
    ? [r.name, "0", "-", "-", "-", "-", "-", "-", "-"]
    : [
        r.name,
        String(r.seconds),
        String(r.fpsMin),
        limited(r, "frame p95", r.frameP95, BUDGET.frameP95, r.frameP95.toFixed(2)),
        limited(r, "over %", r.over, BUDGET.over, String(r.over)),
        limited(r, "js p95", r.jsP95, BUDGET.jsP95, r.jsP95.toFixed(1)),
        r.coreP95.toFixed(1),
        r.cpuSeconds ? `${Math.round(r.cpuSum / r.cpuSeconds)}/${r.cpuMax}` : "-",
        limited(r, "memory", r.memMB, BUDGET.memMB, r.memMB.toFixed(0)),
      ],
);

const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
const format = (row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(format(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of body) console.log(format(row));
console.log(`\nbudgets: frame p95 <= ${BUDGET.frameP95} ms, over <= ${BUDGET.over}%, js p95 <= ${BUDGET.jsP95} ms, rss <= ${BUDGET.memMB} MB. "!" marks a broken one.`);
console.log(realDisplay ? "Measured on the display of this session." : "Measured under Xvfb with the cairo renderer (CPU-drawn): frame times are an upper bound, not the GPU's.");
console.log("A scenario that draws no frame prints no readings (`0` in the s drawn column): an app at rest should be there.");
if (broken.length) console.log(`\nbroken (${broken.length}):\n  ${broken.join("\n  ")}`);
if (failure) {
  console.error(`\nThe run stopped early, so this table is partial:\n${failure}`);
  process.exit(2);
}
if (check && broken.length) process.exit(1);
