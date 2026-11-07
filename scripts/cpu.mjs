// What the app really costs in CPU per scenario. nsh's monitor (`--fps`, scripts/perf.mjs) draws no overlay on Linux, but it
// does sample every second; this runs the same scenario file without it and reads the host process' CPU time from
// /proc/<pid>/stat between the scenario markers (`console.log("PERF-SCENARIO <name>")`), the way `top` would.
//
//   bun scripts/cpu.mjs [file]      # default .perf/scenarios.test.tsx
//
// The host read is the process this script started (a descendant of its own `nsh test`), never one found by name. A
// marker's row spans until the next marker; the scenario file ends with a marker named `end`. Under Xvfb with cairo the drawing cost is
// the CPU's (no GPU): an idle row should still read ~0%.
import { readFileSync, readdirSync } from "node:fs";
import { nshTest } from "./run-linux.mjs";

const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".perf/scenarios.test.tsx";
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
  if (!from.pid || from.pid !== to.pid || Number.isNaN(to.cpu) || !(to.at > from.at)) continue;
  const wall = to.at - from.at;
  rows.push([from.name, wall.toFixed(0), `${(((to.cpu - from.cpu) / wall) * 100).toFixed(0)}%`]);
}
if (rows.length === 0) {
  console.log(`no readings from ${file}: it printed no PERF-SCENARIO marker, or fewer than two markers were printed (a row needs a marker after it, and one host)`);
  process.exit(2);
}
const header = ["scenario", "s", "cpu"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const format = (row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(format(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(format(row));
console.log("\ncpu is the whole host process in percent of one core, from its CPU time between markers (10 ms resolution): short scenarios read coarsely.");
