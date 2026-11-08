import { expect, test } from "nsh/test";

import { tabBadge, tabsCompactFor } from "#components/tab-face";
import type { AgentStatus } from "#lib/status";

test("a tile carries one badge: needs you, then output not yet seen (not in front), then working", () => {
  const cases: [AgentStatus, boolean, string][] = [
    ["blocked", false, "signal"],
    ["blocked", true, "signal"],
    ["done", false, "unseen"],
    ["done", true, ""],
    ["working", false, "working"],
    ["working", true, "working"],
    ["idle", false, ""],
    ["unknown", false, ""],
  ];
  for (const [status, active, badge] of cases) expect(tabBadge(status, active)).toBe(badge);
});

test("tabs stay chips while each keeps 120 pt in one row, and turn to tiles past that", () => {
  // [tabs, room]: the main region beside the full sidebar at 1280 is 1016, beside the rail at 760 it is 696.
  const cases: [number, number, boolean][] = [
    [1, 0, true],
    [1, 200, false],
    [3, 1016, false],
    [8, 1016, false], // 988 of chips: an estimate with a 160 pt front chip turned these to tiles
    [9, 1016, true],
    [5, 696, false],
    [6, 696, true],
    [30, 1016, true],
  ];
  for (const [tabs, room, tiles] of cases)
    expect([tabs, room, tabsCompactFor(tabs, room)]).toEqual([tabs, room, tiles]);
});
