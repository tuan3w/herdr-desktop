import { expect, test } from "nsh/test";

import { pacer } from "#lib/session";

/** The model's use of `pacer`, on a clock the test moves: what each pull sees is everything that arrived before it. */
function stream(interval: number) {
  const pace = pacer(interval);
  const pulls: { at: number; text: string }[] = [];
  let text = "";
  let timer: { at: number } | undefined;
  const pull = (at: number) => {
    timer = undefined;
    pace.ran(at);
    pulls.push({ at, text });
  };
  return {
    pulls,
    /** A chunk arrives at `at` ms; timers due before it run first, as they would. */
    chunk(at: number, more: string) {
      if (timer && timer.at <= at) pull(timer.at);
      text += more;
      const wait = pace.ask(at);
      if (wait === null) return;
      if (wait === 0) pull(at);
      else timer = { at: at + wait };
    },
    /** Lets the time run out: the pending pull happens. */
    settle() {
      if (timer) pull(timer.at);
    },
    text: () => text,
  };
}

test("a burst of 100 chunks in 50 ms is pulled at most once per interval, and the last chunk is always in the last pull", () => {
  const s = stream(120);
  const chunks = Array.from({ length: 100 }, (_, i) => `<${i}>`);
  chunks.forEach((c, i) => s.chunk(i * 0.5, c));
  s.settle();
  const times = s.pulls.map((p) => p.at);
  for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(120);
  expect(s.pulls.length).toBeLessThanOrEqual(2);
  expect(s.pulls.at(-1)!.text).toBe(chunks.join(""));
  // Order is kept: every pull saw a prefix of the whole.
  for (const p of s.pulls) expect(chunks.join("").startsWith(p.text)).toBe(true);
});

test("a stream that is slower than the interval is pulled at once, and a quiet moment brings the first chunk back at once", () => {
  const s = stream(120);
  s.chunk(0, "a");
  s.chunk(500, "b");
  s.chunk(1000, "c");
  expect(s.pulls.map((p) => [p.at, p.text])).toEqual([
    [0, "a"],
    [500, "ab"],
    [1000, "abc"],
  ]);
});

test("a long stream is pulled about every interval and ends on its last chunk", () => {
  const s = stream(120);
  for (let t = 0; t <= 2000; t += 10) s.chunk(t, `${t},`);
  s.settle();
  expect(s.pulls.length).toBeLessThanOrEqual(Math.ceil(2000 / 120) + 1);
  expect(s.pulls.at(-1)!.text).toBe(s.text());
});
