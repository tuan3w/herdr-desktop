// Runs `.perf/scenarios.test.tsx` (or the file you name) in a real GTK window with nsh's monitor on (`--fps`), reads the
// monitor's one line a second (frame rate, main-thread time per frame, JS and core time per commit, CPU, memory) and the
// Rust metrics each scenario logs (`PERF-METRICS`, from `Herdr.metrics()`), and prints one row per scenario.
//
//   bun scripts/perf.mjs                  # the tables, one run
//   bun scripts/perf.mjs --runs 5         # five runs: each cell is the median, with [min-max] beside it
//   bun scripts/perf.mjs --check          # three runs (--runs N changes it), exit 1 when even the best run breaks a budget of .perf/budgets.json
//   bun scripts/perf.mjs --runs 5 --write-budgets   # budgets = the medians x 1.5, memory the highest run x 1.15 (see .perf/budgets.json)
//   bun scripts/perf.mjs --runs 5 --json .scratch/perf.json   # also keep every run's numbers
//   bun scripts/perf.mjs --from a.json,b.json --write-budgets   # aggregate the runs kept by earlier `--json`s (pooled), run nothing
//
// On a display (DISPLAY or WAYLAND_DISPLAY set) the numbers are the GPU's; without one the run is under Xvfb with the cairo
// renderer, which is CPU-rendered, so frame times are an upper bound and only counts and ratios carry over. The monitor
// logs a line only while GTK draws frames: an idle scenario prints none, which is the behaviour to keep ("an app at rest
// draws no frames"), and its row says `0` seconds drawn.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { nshTest, realDisplay } from "./run-linux.mjs";

/** What a scenario without an entry of its own must meet (and what `.perf/budgets.json` `default` overrides). */
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
// A scenario's own entry may also hold `drawn` (seconds with frames drawn, 0 for a scenario that should be at rest) and
// `cpu` (percent of one core, checked by scripts/cpu.mjs).
/** How far over the median a time-like budget sits. 1.15 broke on this shared machine, where one scenario's median moved by 30% between two hours (docs/PERFORMANCE.md). */
const SLACK = 1.5;
/** Memory: over the highest run. */
const MEM_SLACK = 1.15;
const budgetFile = new URL("../.perf/budgets.json", import.meta.url).pathname;
const budgets = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")) : {};
/** The budget of one scenario: the default, then its own entry over it. */
const budgetOf = (name) => ({ ...DEFAULTS, ...budgets.default, ...budgets.scenarios?.[name] });

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const check = flag("check");
const writeBudgets = flag("write-budgets");
// A check takes the median of three runs unless told otherwise: one run of a CPU-drawn scenario swings more than the slack.
const runs = Number(option("runs") ?? (check ? 3 : 1));
const valueOptions = new Set(["runs", "json", "from"]);
const file =
  args.find((a, i) => !a.startsWith("--") && !valueOptions.has(args[i - 1]?.slice(2))) ?? ".perf/scenarios.test.tsx";

// One monitor line: `nsh::perf fps 39/60 frame mean/p50/p95/max gap ... over 3% update ... layout ... paint ... snapshot ...
// canvas ... drain ... commits 5 js m/p50/p95/max core m/p50/p95/max items 137 engine 6% cpu 4% rss 316.3 MB` (`cpu -` on the
// first reading). Only the named groups are used.
const NUMS = "[\\d./]+";
const PERF = new RegExp(
  `nsh::perf fps (?<fps>\\d+)/\\d+ frame [\\d.]+/[\\d.]+/(?<frameP95>[\\d.]+)/[\\d.]+ gap ${NUMS} over (?<over>\\d+)% update ${NUMS} layout ${NUMS} paint ${NUMS} snapshot ${NUMS} canvas ${NUMS} drain ${NUMS} commits (?<commits>\\d+) js [\\d.]+/[\\d.]+/(?<jsP95>[\\d.]+)/[\\d.]+ core [\\d.]+/[\\d.]+/(?<coreP95>[\\d.]+)/[\\d.]+ items \\d+ engine \\d+% cpu (?<cpu>\\d+|-)%? rss (?<mem>[\\d.]+) MB`,
);

/** One run of the scenario file: its rows by scenario, and the notes the scenarios printed. */
async function runOnce() {
  const run = Bun.spawn(["sh", "-c", `${nshTest(file, "--fps -v")} 2>&1`], { stdout: "pipe" });
  const output = await new Response(run.stdout).text();
  await run.exited;
  const rows = [];
  const notes = [];
  let current = null;
  /** The rolling figures of the previous reading: one that has not moved is the same window again, not a new second. */
  const previous = { frameP95: "", over: "", jsP95: "", coreP95: "" };
  for (const line of output.split("\n")) {
    const marker = line.match(/PERF-SCENARIO (.+)$/);
    if (marker) {
      current = {
        name: marker[1].trim(),
        seconds: 0,
        cpuSeconds: 0,
        fpsMin: Infinity,
        frameP95: 0,
        over: 0,
        jsP95: 0,
        coreP95: 0,
        cpuSum: 0,
        cpuMax: 0,
        memMB: 0,
        metrics: null,
        live: null,
      };
      rows.push(current);
      continue;
    }
    const metrics = line.match(/PERF-METRICS (\{.*\})\s*$/);
    if (metrics && current) {
      current.metrics = JSON.parse(metrics[1]);
      continue;
    }
    const live = line.match(/PERF-LIVE (\{.*\})\s*$/);
    if (live && current) {
      current.live = JSON.parse(live[1]);
      continue;
    }
    const note = line.match(/PERF-NOTE (.+)$/);
    if (note) {
      notes.push(note[1].trim());
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
  const failure = failedAt >= 0 ? lines.slice(failedAt, failedAt + 3).join("\n") : "";
  return { rows: rows.filter((r) => r.name !== "end"), notes, failure, tail: lines.slice(-15).join("\n") };
}

/** The figures of one row, by the name the table and the budgets use. */
function figures(r) {
  const m = r.metrics ?? {};
  return {
    drawn: r.seconds,
    fpsMin: r.seconds ? r.fpsMin : null,
    frameP95: r.seconds ? r.frameP95 : null,
    over: r.seconds ? r.over : null,
    jsP95: r.seconds ? r.jsP95 : null,
    coreP95: r.seconds ? r.coreP95 : null,
    cpuAvg: r.cpuSeconds ? r.cpuSum / r.cpuSeconds : null,
    cpuMax: r.cpuSeconds ? r.cpuMax : null,
    memMB: r.seconds ? r.memMB : (m.rssMb ?? null),
    reads: r.live ? r.live.paneReadsPerSecond : null,
    paintP50: m.readToPaintSamples ? m.readToPaintMsP50 : null,
    paintP95: m.readToPaintSamples ? m.readToPaintMsP95 : null,
    parse: m.parseUsPerRow || null,
    rebound: m.rowsReboundPerUpdate || null,
    reboundMax: m.rowsReboundLast || null,
    rss: m.rssMb ?? null,
    threads: m.threads ?? null,
    fds: m.openFds ?? null,
  };
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const spread = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined);
  return s.length ? [Math.min(...s), Math.max(...s)] : null;
};

const results = [];
const notes = [];
const saved = option("from");
if (saved) {
  // Aggregate the runs a former `--json` kept, instead of running the scenarios again.
  for (const path of saved.split(",")) results.push(...JSON.parse(readFileSync(path, "utf8")));
}
for (let i = 0; !saved && i < runs; i++) {
  if (runs > 1) console.error(`run ${i + 1} of ${runs}...`);
  const run = await runOnce();
  if (run.rows.length === 0) {
    console.error("No scenario ran: does the file print PERF-SCENARIO markers?\n" + run.tail);
    process.exit(2);
  }
  if (run.failure) {
    console.error(`\nThe run stopped early, so its table is partial:\n${run.failure}`);
    process.exit(2);
  }
  results.push(run.rows.map((r) => ({ name: r.name, ...figures(r) })));
  if (i === 0) notes.push(...run.notes);
}

// Aggregate by scenario, in the order of the first run.
const names = results[0].map((r) => r.name);
const aggregate = names.map((name) => {
  const mine = results.map((run) => run.find((r) => r.name === name)).filter(Boolean);
  const cell = {};
  for (const key of Object.keys(mine[0]).filter((k) => k !== "name")) {
    const values = mine.map((r) => r[key]);
    cell[key] = { median: median(values), range: spread(values) };
  }
  return { name, cell, runs: mine.length };
});

if (option("json")) writeFileSync(option("json"), JSON.stringify(results, null, 1));

const fmt = (digits) => (c) => {
  if (c.median === null) return "-";
  const one = c.median.toFixed(digits);
  if (results.length === 1 || !c.range) return one;
  const [lo, hi] = c.range;
  return lo === hi ? one : `${one} [${lo.toFixed(digits)}-${hi.toFixed(digits)}]`;
};
const broken = [];
/**
 * The text of a cell, with `!` after it when the figure that is held to `limit` is over it; the breach is noted for the
 * summary. Time-like figures are held at their best run (`best`): noise on a shared machine only makes a run slower, so a
 * breach in every run is a real one; memory is held at its median (its best is the low mode, see docs/PERFORMANCE.md).
 */
const limited = (row, key, column, digits, limit, best = true) => {
  const text = fmt(digits)(row.cell[key]);
  const value = best && row.cell[key].range ? row.cell[key].range[0] : row.cell[key].median;
  if (value === null || limit === undefined || value <= limit) return text;
  broken.push(
    `${row.name}: ${column} ${best && results.length > 1 ? "best " : ""}${value.toFixed(digits)} > ${limit} (${text})`,
  );
  return `${text}!`;
};

function print(header, body) {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const format = (row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(format(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(format(row));
}

const frames = aggregate.map((row) => {
  const b = budgetOf(row.name);
  const drawn = row.cell.drawn.median;
  return [
    row.name,
    limited(row, "drawn", "seconds drawn", 0, b.drawn),
    drawn ? fmt(0)(row.cell.fpsMin) : "-",
    drawn ? limited(row, "frameP95", "frame p95", 2, b.frameP95) : "-",
    drawn ? limited(row, "over", "over %", 0, b.over) : "-",
    drawn ? limited(row, "jsP95", "js p95", 1, b.jsP95) : "-",
    drawn ? fmt(1)(row.cell.coreP95) : "-",
    row.cell.cpuAvg.median === null ? "-" : `${fmt(0)(row.cell.cpuAvg)}/${fmt(0)(row.cell.cpuMax)}`,
    limited(row, "memMB", "memory", 0, b.memMB, false),
  ];
});
console.log(
  `Frames and process, from the monitor (${results.length} run${results.length > 1 ? "s, median [min-max]" : ""}):\n`,
);
print(["scenario", "s drawn", "fps min", "frame p95", "over %", "js p95", "core p95", "cpu avg/max", "rss MB"], frames);

const rust = aggregate.map((row) => [
  row.name,
  fmt(1)(row.cell.reads),
  row.cell.paintP50.median === null ? "-" : `${fmt(2)(row.cell.paintP50)} / ${fmt(2)(row.cell.paintP95)}`,
  fmt(1)(row.cell.parse),
  row.cell.rebound.median === null ? "-" : `${fmt(1)(row.cell.rebound)} / ${fmt(0)(row.cell.reboundMax)}`,
  fmt(0)(row.cell.rss),
  fmt(0)(row.cell.threads),
  fmt(0)(row.cell.fds),
]);
console.log("\nRust metrics (`Herdr.metrics()` at the end of the scenario; reads/s while the stream still ran):\n");
print(
  [
    "scenario",
    "reads/s",
    "read to paint p50 / p95 ms",
    "parse us/row",
    "rebound mean / max",
    "rss MB",
    "threads",
    "fds",
  ],
  rust,
);

for (const note of notes) console.log(`\nnote: ${note}`);
console.log(
  `\nbudgets (${existsSync(budgetFile) ? ".perf/budgets.json" : "defaults"}): a "!" marks a figure over its budget: the best run for times, the median for memory.`,
);
console.log(
  realDisplay
    ? "Measured on the display of this session."
    : "Measured under Xvfb with the cairo renderer (CPU-drawn): frame times are an upper bound, not the GPU's.",
);
console.log(
  "A scenario that draws no frame prints no frame readings (`0` seconds drawn): an app at rest should be there.",
);

if (writeBudgets) {
  const scenarios = {};
  const up = (x, digits) => Math.ceil(x * SLACK * 10 ** digits) / 10 ** digits;
  for (const row of aggregate) {
    const c = row.cell;
    // Keep what scripts/cpu.mjs wrote (`cpu`); this script owns the rest.
    const entry = { cpu: budgets.scenarios?.[row.name]?.cpu };
    if (entry.cpu === undefined) delete entry.cpu;
    if (!c.drawn.median) {
      // At rest: no frames at all.
      entry.drawn = 0;
    } else {
      // A median of 0 (the monitor's window did not move) would make the budget 0: the floors keep a budget from failing on noise (a CPU-drawn frame under 5 ms is inside it).
      entry.frameP95 = Math.max(up(c.frameP95.median, 2), 5);
      entry.over = Math.max(up(c.over.median, 0), 5);
      entry.jsP95 = Math.max(up(c.jsP95.median, 1), 2);
    }
    // Memory is two-valued in a run: the engine's idle collection, when it happens to run, takes ~190 MB off the resident set, so the
    // median can sit in either mode. The budget guards the high one: the most any run reached.
    entry.memMB = Math.ceil((c.memMB.range ? c.memMB.range[1] : c.memMB.median) * MEM_SLACK);
    scenarios[row.name] = entry;
  }
  const note = realDisplay
    ? "Measured on a real display: the frame budgets are the GPU's."
    : "Measured under Xvfb with the cairo renderer on the dev host (unoptimized Rust): CPU-drawn numbers, so the frame budgets are regression guards and not the product target (frame p95 < 8.3 ms at 120 Hz on a real display, unverified). Each time budget is the median of the runs x 1.5 (1.15 broke on this shared machine, whose speed moves by 30% between hours), except memMB (the highest any run reached x 1.15: the resident set has two modes) and a scenario at rest (drawn 0, cpu 1). cpu is checked by scripts/cpu.mjs. A check holds the best of its three runs to a budget (noise on a shared machine only slows a run) and memMB at the median. See docs/PERFORMANCE.md.";
  const out = {
    note,
    measured: {
      runs: results.length,
      slack: SLACK,
      display: realDisplay ? "real" : "xvfb-cairo",
      date: new Date().toISOString().slice(0, 10),
    },
    default: { ...DEFAULTS, ...budgets.default },
    scenarios,
  };
  writeFileSync(budgetFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\nwrote ${budgetFile} from the medians of ${results.length} run${results.length > 1 ? "s" : ""} x ${SLACK}.`,
  );
}

if (broken.length) console.log(`\nbroken (${broken.length}):\n  ${broken.join("\n  ")}`);
if (check) {
  if (!existsSync(budgetFile)) {
    console.error("--check needs .perf/budgets.json (bun scripts/perf.mjs --runs 5 --write-budgets writes it)");
    process.exit(2);
  }
  const unbudgeted = aggregate.filter((r) => !budgets.scenarios?.[r.name]).map((r) => r.name);
  if (unbudgeted.length) {
    console.error(
      `\nscenarios with no entry in .perf/budgets.json (they only meet the default): ${unbudgeted.join(", ")}`,
    );
    process.exit(1);
  }
  if (broken.length) process.exit(1);
}
