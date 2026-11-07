import { expect, test } from "nsh/test";

import { homeLines, STRIP_SHOWN, strip, WIDE_ROWS } from "#lib/board-items";
import { boardData, project, row } from "#lib/board-rows.fixture";

const agents = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => row(`local/${prefix}${i}`, { status: "working" }));
const shape = (lines: ReturnType<typeof homeLines>) => lines.map((l) => l.projects.map((p) => p.name).join("+"));

test("the strip answers the agent that has waited longest, and says how many more wait", () => {
  const waiting = [1, 2, 3, 4, 5].map((n) => row(`local/w${n}`, { status: "blocked" }));
  const gone = row("far/g1", { status: "blocked", offline: true });
  const board = boardData([project("api", waiting), project("far", [gone])]);
  const s = strip(board);
  expect(s.rows.map((r) => r.paneId)).toEqual(["w1"]);
  expect(s.rows).toHaveLength(STRIP_SHOWN);
  expect(s.more).toBe(4);
  expect(strip(boardData([project("quiet", agents("a", 2))])).rows).toEqual([]);
});

test("a narrow home is one card per line, a wide one two, in the board's order", () => {
  const projects = ["a", "b", "c"].map((n) => project(n, agents(n, 1)));
  expect(shape(homeLines(projects, 1, [], []))).toEqual(["a", "b", "c"]);
  expect(shape(homeLines(projects, 2, [], []))).toEqual(["a+b", "c"]);
});

test("a project listing many agents takes the whole line; folded, it is a small card again", () => {
  const big = project("big", agents("x", WIDE_ROWS));
  const projects = [project("a", agents("a", 1)), big, project("c", agents("c", 1)), project("d", agents("d", 1))];
  expect(shape(homeLines(projects, 2, [], []))).toEqual(["a", "big", "c+d"]);
  expect(shape(homeLines(projects, 2, [], [big.key]))).toEqual(["a+big", "c+d"]);
});

test("a card does not move when a project before it changes state, only when it grows past the wide limit", () => {
  const before = [project("a", agents("a", 2)), project("b", agents("b", 2)), project("c", agents("c", 1))];
  const after = [
    project("a", [row("local/a0", { status: "blocked" }), row("local/a1", { status: "done" })]),
    before[1],
    before[2],
  ];
  expect(shape(homeLines(after, 2, [], []))).toEqual(shape(homeLines(before, 2, [], [])));
});

test("idle agents beyond the first few do not make a card wide while they fold, only once they are listed", () => {
  const quiet = project(
    "q",
    Array.from({ length: 10 }, (_, i) => row(`local/i${i}`, { status: "idle" })),
  );
  const projects = [quiet, project("r", agents("r", 1))];
  expect(shape(homeLines(projects, 2, [], []))).toEqual(["q+r"]);
  expect(shape(homeLines(projects, 2, [quiet.key], []))).toEqual(["q", "r"]);
});

test("the agents the strip does not show are counted per project, in the order they have waited, not listed", () => {
  const docs = project(
    "docs",
    [1, 2, 3].map((n) => row(`local/d${n}`, { status: "blocked" })),
  );
  const infra = project(
    "infra",
    [1, 2].map((n) => row(`local/i${n}`, { status: "blocked" })),
  );
  const board = boardData([docs, infra], {
    needsYou: [docs.rows[0], infra.rows[0], docs.rows[1], infra.rows[1], docs.rows[2]],
  });
  const s = strip(board);
  expect(s.more).toBe(4);
  expect(s.moreIn).toEqual([
    { name: "infra", count: 2 },
    { name: "docs", count: 2 },
  ]);
});
