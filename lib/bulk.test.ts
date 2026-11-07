import { expect, test } from "nsh/test";
import type { BoardRow } from "herdr-desktop/native";
import { planBulk } from "./bulk";

const row = (pane: string, over: Partial<BoardRow> = {}): BoardRow => ({
  key: `local/${pane}`,
  machine: "local",
  machineName: "This computer",
  paneId: pane,
  workspaceId: "w1",
  tabId: "w1:t1",
  agent: "claude",
  name: pane,
  status: "working",
  offline: false,
  reviewed: false,
  reviewKey: `local|${pane}|1`,
  preview: [],
  ...over,
});

test("an agent waiting on a question is skipped unless the person includes it, and an unreachable one never is reached", () => {
  const picked = [row("p1"), row("p2", { status: "blocked" }), row("p3", { status: "done" }), row("p4", { offline: true, status: "blocked" })];

  const careful = planBulk(picked, false);
  expect(careful.targets.map((r) => r.paneId)).toEqual(["p1", "p3"]);
  expect(careful.waiting.map((r) => r.paneId)).toEqual(["p2"]);
  expect(careful.offline.map((r) => r.paneId)).toEqual(["p4"]);

  const anyway = planBulk(picked, true);
  expect(anyway.targets.map((r) => r.paneId)).toEqual(["p1", "p2", "p3"]);
  expect(anyway.offline.map((r) => r.paneId)).toEqual(["p4"]);
});
