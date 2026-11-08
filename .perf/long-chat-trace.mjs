// Per-step commit cost of a `nsh test --trace` run of components/long-chat.test.tsx, by phase.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n");
const phases = {};
let phase = "open";
let acc = { us: 0, js: 0, items: 0, commits: 0 };
const counts = {};
for (const l of lines) {
  let m = /^perf commit: \d+ ops, (\d+)µs \(list js (\d+)µs\), (\d+) mount items/.exec(l);
  if (m) {
    acc.us += +m[1];
    acc.js += +m[2];
    acc.items += +m[3];
    acc.commits++;
    continue;
  }
  m = /^── (\S+?)\((.*?)\)/.exec(l);
  if (m) {
    const key = `${m[1]}(${m[2]})`;
    if (/pagedown|pageup|scroll/.test(key)) (phases[phase] ??= []).push(acc);
    acc = { us: 0, js: 0, items: 0, commits: 0 };
    continue;
  }
  m = /^COUNTS (\w+)[^{]*(\{.*\})/.exec(l);
  if (m) {
    counts[m[1]] = JSON.parse(m[2]);
    phase = { open: "home", home: "down", down: "up", up: "wheel" }[m[1]] ?? m[1];
  }
}
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
for (const [name, steps] of Object.entries(phases)) {
  const us = steps.map((s) => s.us),
    items = steps.map((s) => s.items),
    js = steps.map((s) => s.js);
  console.log(
    `${name}: steps ${steps.length}, commit ms p50 ${(q(us, 0.5) / 1000).toFixed(2)} p95 ${(q(us, 0.95) / 1000).toFixed(2)} max ${(Math.max(...us) / 1000).toFixed(2)} sum ${(us.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}; list js p50 ${(q(js, 0.5) / 1000).toFixed(2)} p95 ${(q(js, 0.95) / 1000).toFixed(2)}; mount items p50 ${q(items, 0.5)} p95 ${q(items, 0.95)} sum ${items.reduce((a, b) => a + b, 0)}`,
  );
}
for (const [k, c] of Object.entries(counts)) {
  const h = Object.keys(c)
    .filter((x) => x.startsWith("h."))
    .map((x) => `${x.slice(2)} ${Math.round(c[x] / c["n." + x.slice(2)])}`)
    .join(", ");
  const rest = Object.fromEntries(Object.entries(c).filter(([x]) => !/^[hn]\./.test(x)));
  console.log(`counts ${k}: ${JSON.stringify(rest)}${h ? ` | mean h: ${h}` : ""}`);
}
