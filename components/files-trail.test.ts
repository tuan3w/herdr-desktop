import { expect, test } from "nsh/test";

import { fitTrail, TRAIL, trailNeed } from "#components/files-trail";

const names = (items: ReturnType<typeof fitTrail>) =>
  items.map((i) => (i.kind === "gap" ? `…${i.hidden.length}` : i.crumb.name));

// `/`, `Users`, `dev`, `herdr-desktop`, `test-tree`, `docs`: drawn widths with padding, as measured.
const PATH = "/Users/dev/herdr-desktop/test-tree/docs";
const W = [30, 60, 46, 120, 84, 52];
const whole = W.reduce((a, b) => a + b, 0) + TRAIL.chevron * (W.length - 1);

test("a path that fits is drawn whole, to the point", () => {
  expect(names(fitTrail(PATH, W, whole))).toEqual(["/", "Users", "dev", "herdr-desktop", "test-tree", "docs"]);
});

test("one point short collapses the middle and keeps as many last folders as fit", () => {
  // `Users` (60) gives way to the `…` (28): the rest fits again.
  expect(names(fitTrail(PATH, W, whole - 1))).toEqual(["/", "…1", "dev", "herdr-desktop", "test-tree", "docs"]);
  expect(names(fitTrail(PATH, W, 30 + 52 + TRAIL.gap + 2 * TRAIL.chevron + 84 + TRAIL.chevron))).toEqual([
    "/",
    "…3",
    "test-tree",
    "docs",
  ]);
});

test("the root and the current folder stay however small the room", () => {
  expect(names(fitTrail(PATH, W, 10))).toEqual(["/", "…4", "docs"]);
  expect(names(fitTrail("/", [30], 0))).toEqual(["/"]);
  expect(names(fitTrail("~/app", [24, 40], 0))).toEqual(["~", "app"]);
});

test("a 120-character folder name is kept as the current folder, not dropped", () => {
  const long = "x".repeat(120);
  const items = fitTrail(`/a/b/${long}`, [30, 20, 20, 900], 300);
  expect(names(items)).toEqual(["/", "…2", long]);
});

test("the trail asks for the root, the … and the current folder whole, capped so a long name fades instead", () => {
  expect(trailNeed(W)).toBe(30 + TRAIL.chevron + TRAIL.gap + TRAIL.chevron + 52 + TRAIL.edit);
  expect(trailNeed([30, 52])).toBe(30 + TRAIL.chevron + 52 + TRAIL.edit);
  expect(trailNeed([30, 20, 2000])).toBe(176);
  expect(trailNeed([])).toBe(0);
});
