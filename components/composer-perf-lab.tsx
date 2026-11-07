import { Compose, Herdr } from "herdr-desktop/native";
import { host, mount, signal, Text, View } from "nsh";

import { startHerdr } from "#lib/herdr";

/**
 * What the message box costs, measured through the real Rust module: the `@` list on a big project, a big picture prepared
 * while the UI thread keeps its timer, and the memory after many attach and remove cycles. Run by `.perf/composer.test.tsx`
 * (parameters `root`: a folder to walk, `picture`: a big PNG). Not part of the app.
 */
const params = host.params as { root: string; picture: string };
startHerdr("", "empty");

const lines: string[] = [];
const finished = signal(false);
const say = (line: string) => {
  lines.push(line);
  console.log(`COMPOSER-PERF ${line}`);
};
const percentile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function run() {
  const found = await Compose.mentions("local", params.root, "", 8, [], []);
  say(`index ${found.indexed} paths`);
  for (const query of ["", "p", "pal", "palette", "comp pal", "paletet", "zzzzzz"]) {
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const at = Date.now();
      await Compose.mentions("local", params.root, query, 8, ["payments/ledger"], []);
      ms.push(Date.now() - at);
    }
    say(`mention ${JSON.stringify(query)} p50_ms=${percentile(ms, 0.5)} p95_ms=${percentile(ms, 0.95)}`);
  }

  // A 4 MB picture decoded, scaled and encoded while a 4 ms timer keeps running on the UI thread.
  const gaps: number[] = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, 4);
  const at = Date.now();
  const done = await Compose.preparePaths([params.picture], false);
  const took = Date.now() - at;
  clearInterval(timer);
  say(
    `picture ${done[0]?.kind} took_ms=${took} ui_timer_gap_p95_ms=${percentile(gaps, 0.95)} ui_timer_gap_max_ms=${Math.max(...gaps)}`,
  );

  // 20 attach and remove cycles: what is held is a path and a thumbnail, so the process size must not climb.
  const before = Herdr.metrics().rssMb;
  for (let i = 0; i < 20; i++) {
    const again = await Compose.preparePaths([params.picture], i % 2 === 0);
    void again;
  }
  const after = Herdr.metrics().rssMb;
  const marks: number[] = [];
  for (let i = 1; i <= 60; i++) {
    await Compose.preparePaths([params.picture], i % 2 === 0);
    if (i % 20 === 0) marks.push(Math.round(Herdr.metrics().rssMb));
  }
  say(
    `rss before_mb=${Math.round(before)} after_20_cycles_mb=${Math.round(after)} after_20_40_60_more_mb=${marks.join(",")}`,
  );
  say("done");
  finished.set(true);
}
void run();

mount(() => (
  <View class="p-4">
    <Text>composer perf lab</Text>
    <Text>{finished() ? "done" : "running"}</Text>
  </View>
));
