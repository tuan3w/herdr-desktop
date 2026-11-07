// What the app really costs in CPU per scenario. nsh's monitor (`--fps`, scripts/perf.mjs) draws no overlay on Linux, but it
// does sample every second; this runs the same scenario file without it and reads the host process' CPU time from
// /proc/<pid>/stat between the scenario markers (`console.log("PERF-SCENARIO <name>")`), the way `top` would.
//
//   bun scripts/cpu.mjs [file]               # default .perf/scenarios.test.tsx, one run
//   bun scripts/cpu.mjs --runs 5             # five runs: median, with [min-max]
//   bun scripts/cpu.mjs --check              # three runs (--runs N changes it), exit 1 when even the best run is over its `cpu` budget in .perf/budgets.json
//   bun scripts/cpu.mjs --runs 5 --write-budgets   # `cpu` budgets: the median x 1.5 (see scripts/perf.mjs), and 1% for a scenario at rest
//
// The host read is the process this script started (a descendant of its own `nsh test`), never one found by name. A
// marker's row spans until the next marker; a window's last marker is named `end`. Under Xvfb with cairo the drawing cost is
// the CPU's (no GPU): an idle row should still read ~0%.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { nshTest, realDisplay } from "./run-linux.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
// A check takes the median of three runs unless told otherwise.
const runs = Number(option("runs") ?? (flag("check") ? 3 : 1));
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs") ?? ".perf/scenarios.test.tsx";
const budgetFile = new URL("../.perf/budgets.json", import.meta.url).pathname;
const budgets = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")) : {};
const TICKS = 100; // sysconf(_SC_CLK_TCK) on Linux x86_64

/** The child processes of `pid`, from /proc. */
function children(pid) {
  const out = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // The command may hold spaces and parentheses: the fields start after the last `)`.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === pid) out.push(Number(entry));
    } catch {}
  }
  return out;
}

/** Every descendant of `pid` that is the app's nsh test host (`nsh-app-<crate>-linux-host`). */
function hosts(pid) {
  const found = [];
  const stack = [pid];
  while (stack.length) {
    const next = stack.pop();
    for (const child of children(next)) {
      stack.push(child);
      try {
        if (readFileSync(`/proc/${child}/cmdline`, "utf8").includes("linux-host")) found.push(child);
      } catch {}
    }
  }
  return found;
}

/** The process' CPU time in seconds (user + system), or NaN when it is gone. */
function cpuSeconds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / TICKS;
  } catch {
    return NaN;
  }
}

/** One run of the scenario file: the CPU percent of every scenario row (one core = 100). */
async function runOnce() {
  const run = Bun.spawn(["sh", "-c", `${nshTest(file, "-v")} 2>&1`], { stdout: "pipe" });
  const samples = [];

  /** One reading: the newest host's CPU time and the clock. Without a host yet there is nothing to read. */
  function sample(name) {
    const pid = hosts(run.pid).sort((a, b) => b - a)[0];
    samples.push({ name, pid, cpu: pid ? cpuSeconds(pid) : NaN, at: performance.now() / 1000 });
  }

  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of run.stdout) {
    tail += decoder.decode(chunk, { stream: true });
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const marker = /PERF-SCENARIO (.+)$/.exec(line);
      if (marker) sample(marker[1].trim());
    }
  }
  await run.exited;

  const rows = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const [from, to] = [samples[i], samples[i + 1]];
    // A new host between two markers is a new process: its clock does not continue the old one's.
    if (!from.pid || from.pid !== to.pid || Number.isNaN(to.cpu) || !(to.at > from.at) || from.name === "end") continue;
    const wall = to.at - from.at;
    rows.push({ name: from.name, wall, cpu: ((to.cpu - from.cpu) / wall) * 100 });
  }
  return rows;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const results = [];
for (let i = 0; i < runs; i++) {
  if (runs > 1) console.error(`run ${i + 1} of ${runs}...`);
  const rows = await runOnce();
  if (rows.length === 0) {
    console.log(
      `no readings from ${file}: it printed no PERF-SCENARIO marker, or fewer than two markers were printed (a row needs a marker after it, and one host)`,
    );
    process.exit(2);
  }
  results.push(rows);
}

const aggregate = results[0].map((first) => {
  const mine = results.map((run) => run.find((r) => r.name === first.name)).filter(Boolean);
  const cpus = mine.map((r) => r.cpu);
  return {
    name: first.name,
    wall: median(mine.map((r) => r.wall)),
    cpu: median(cpus),
    lo: Math.min(...cpus),
    hi: Math.max(...cpus),
  };
});

const broken = [];
const body = aggregate.map((row) => {
  const budget = budgets.scenarios?.[row.name]?.cpu;
  // The best run is held to the budget: noise on a shared machine only makes a run slower.
  const over = budget !== undefined && row.lo > budget;
  if (over) broken.push(`${row.name}: cpu best ${row.lo.toFixed(1)}% > ${budget}%`);
  const text =
    runs > 1 ? `${row.cpu.toFixed(1)}% [${row.lo.toFixed(1)}-${row.hi.toFixed(1)}]` : `${row.cpu.toFixed(1)}%`;
  return [row.name, row.wall.toFixed(0), over ? `${text}!` : text];
});
const header = ["scenario", "s", "cpu"];
const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
const format = (row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(format(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of body) console.log(format(row));
console.log(
  `\ncpu is the whole host process in percent of one core, from its CPU time between markers (10 ms resolution)${runs > 1 ? `; median of ${runs} runs with [min-max]` : ""}: short scenarios read coarsely.`,
);
console.log(
  realDisplay
    ? "Measured on the display of this session."
    : "Measured under Xvfb with the cairo renderer (CPU-drawn): the drawing cost is the CPU's, so it is an upper bound for a GPU.",
);

if (flag("write-budgets")) {
  // `drawn: 0` marks a scenario at rest (scripts/perf.mjs writes it): its budget is 1% of a core, the rest is the median x 1.5.
  const scenarios = budgets.scenarios ?? {};
  for (const row of aggregate) {
    const entry = scenarios[row.name] ?? {};
    entry.cpu = entry.drawn === 0 ? 1 : Math.max(1, Math.ceil(row.cpu * 1.5));
    scenarios[row.name] = entry;
  }
  const out = { ...budgets, scenarios };
  writeFileSync(budgetFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote the cpu budgets of ${aggregate.length} scenarios to ${budgetFile}.`);
}
if (broken.length) console.log(`\nbroken (${broken.length}):\n  ${broken.join("\n  ")}`);
if (flag("check")) {
  if (!existsSync(budgetFile)) {
    console.error(
      "--check needs .perf/budgets.json (bun scripts/cpu.mjs --runs 5 --write-budgets writes the cpu part)",
    );
    process.exit(2);
  }
  const missing = aggregate.filter((r) => budgets.scenarios?.[r.name]?.cpu === undefined).map((r) => r.name);
  if (missing.length) {
    console.error(`\nscenarios with no \`cpu\` budget: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (broken.length) process.exit(1);
}
