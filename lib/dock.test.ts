import { expect, test } from "nsh/test";
import type { DockAreaLayout } from "nsh/base";
import { BOARD, defaultLayout, groupOf, groups, otherGroup, panelsOf, paneKey, parsePaneKey, parseSessionKey, readLayout, rowKeyOf, sessionKey } from "#lib/dock";

const A = paneKey("local", "w1:p1");
const B = paneKey("m1", "w2:p3");

const split = (...cols: string[][]): DockAreaLayout => ({
  center: { type: "split", axis: "horizontal", children: cols.map((panels) => ({ type: "tabs", panels })) },
});

test("a pane key reads back to its machine and pane, ids with colons included, and nothing else is a pane", () => {
  expect(parsePaneKey(A)).toEqual({ machine: "local", pane: "w1:p1" });
  expect(parsePaneKey(B)).toEqual({ machine: "m1", pane: "w2:p3" });
  expect(parsePaneKey(BOARD)).toBeNull();
  expect(parsePaneKey("pane:local/")).toBeNull();
  expect(parsePaneKey("pane:/w1:p1")).toBeNull();
});

test("a saved layout is reopened as it was, split sizes and the displayed tab included", () => {
  const saved = JSON.stringify({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD, A], activeIndex: 1 },
        { type: "tabs", panels: [B], activeIndex: 0 },
      ],
      sizes: [500, null],
    },
  });
  const layout = readLayout(saved);
  expect(groups(layout).map((g) => [g.panels, g.active])).toEqual([
    [[BOARD, A], 1],
    [[B], 0],
  ]);
  expect(layout.center).toMatchObject({ sizes: [500, null] });
});

test("a damaged or foreign file never breaks the start: the board alone opens", () => {
  for (const raw of [null, "", "not json", "{}", '{"center":7}', '{"center":{"type":"tabs","panels":[]}}']) {
    expect(readLayout(raw)).toEqual(defaultLayout());
  }
});

test("tabs for things that cannot be opened are dropped, a tab listed twice keeps its first place, empty groups go", () => {
  const saved = JSON.stringify({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD, "settings", A, A, 5] },
        { type: "tabs", panels: ["files", A] },
        { type: "bogus" },
      ],
    },
  });
  expect(groups(readLayout(saved)).map((g) => g.panels)).toEqual([[BOARD, A]]);
});

test("the board is put back at the front when the saved layout lost it, and the displayed tab stays the same one", () => {
  const layout = readLayout(JSON.stringify(split([A, B])));
  expect(groups(layout)).toEqual([{ id: undefined, panels: [BOARD, A, B], active: 1 }]);
});

test("a layout with only a tab group at its root still opens as a split", () => {
  const layout = readLayout(JSON.stringify({ center: { type: "tabs", panels: [BOARD, A] } }));
  expect(layout.center.type).toBe("split");
  expect(panelsOf(layout)).toEqual([BOARD, A]);
});

test("the other group is the next one in reading order, wrapping, and absent when there is only one", () => {
  const layout = split([BOARD], [A], [B]);
  expect(otherGroup(layout, BOARD)?.panels).toEqual([A]);
  expect(otherGroup(layout, B)?.panels).toEqual([BOARD]);
  expect(otherGroup(split([BOARD, A]), A)).toBeUndefined();
  expect(groupOf(layout, B)?.panels).toEqual([B]);
  expect(groupOf(layout, "pane:gone/x")).toBeUndefined();
});

test("groups are read through nested splits left to right, top to bottom", () => {
  const layout: DockAreaLayout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD] },
        { type: "split", axis: "vertical", children: [{ type: "tabs", panels: [A] }, { type: "tabs", panels: [B] }] },
      ],
    },
  };
  expect(panelsOf(layout)).toEqual([BOARD, A, B]);
});

test("a chat tab reads back to its machine and session, and every kind of tab names the one board row it is about", () => {
  const keeper = sessionKey("local", "abc234");
  const observed = sessionKey("local", "pane:w1:p1");
  expect(parseSessionKey(keeper)).toEqual({ machine: "local", id: "abc234" });
  expect(parseSessionKey(observed)).toEqual({ machine: "local", id: "pane:w1:p1" });
  expect(parseSessionKey(A)).toBeNull();
  expect(parsePaneKey(keeper)).toBeNull();
  expect(rowKeyOf(A)).toBe("local/w1:p1");
  // The terminal and the chat read from it are two views of one agent: one row.
  expect(rowKeyOf(observed)).toBe("local/w1:p1");
  expect(rowKeyOf(keeper)).toBe("local/session:abc234");
  expect(rowKeyOf(BOARD)).toBeNull();
});

test("saved chat tabs reopen with the layout, next to the terminals", () => {
  const chat = sessionKey("local", "pane:w1:p1");
  const layout = readLayout(JSON.stringify(split([BOARD, A, chat])));
  expect(panelsOf(layout)).toEqual([BOARD, A, chat]);
});
