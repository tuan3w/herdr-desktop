import { expect, test } from "nsh/test";
import { planBulk } from "#lib/bulk";
import { row } from "#lib/board-rows.fixture";

test("an agent waiting on a question is skipped unless the person includes it, and an unreachable one never is reached", () => {
  const picked = [row("local/p1"), row("local/p2", { status: "blocked" }), row("local/p3", { status: "done" }), row("local/p4", { offline: true, status: "blocked" })];

  const careful = planBulk(picked, false);
  expect(careful.targets.map((r) => r.paneId)).toEqual(["p1", "p3"]);
  expect(careful.waiting.map((r) => r.paneId)).toEqual(["p2"]);
  expect(careful.offline.map((r) => r.paneId)).toEqual(["p4"]);

  const anyway = planBulk(picked, true);
  expect(anyway.targets.map((r) => r.paneId)).toEqual(["p1", "p2", "p3"]);
  expect(anyway.offline.map((r) => r.paneId)).toEqual(["p4"]);
});
