import { expect, test } from "nsh/test";

import type { BoardData, BoardRow } from "herdr-desktop/native";

import { attentionOrder, stepAttention } from "#lib/actions";

/** A row with only what the walk reads; the rest of a board row is not its business. */
const row = (key: string, extra: Partial<BoardRow> = {}): BoardRow =>
  ({ key, status: "blocked", offline: false, sinceSecs: 0, ...extra }) as BoardRow;

const board = (needsYou: BoardRow[], others: BoardRow[] = []): BoardData =>
  ({ needsYou, projects: [{ rows: [...needsYou, ...others] }] }) as unknown as BoardData;

test("the walk visits the agents that wait, in the order the board lists them, and never one that only finished", () => {
  const data = board([row("m/a"), row("m/b")], [row("m/done", { status: "done", sinceSecs: 5 })]);
  expect(attentionOrder(data).map((r) => r.key)).toEqual(["m/a", "m/b"]);
});

test("an agent on a machine that is not connected is not visited", () => {
  const data = board([row("m/a", { offline: true }), row("m/b")]);
  expect(attentionOrder(data).map((r) => r.key)).toEqual(["m/b"]);
});

test("next and previous wrap around the list", () => {
  const order = [row("m/a"), row("m/b"), row("m/c")];
  expect(stepAttention(order, "m/c", 1)?.key).toBe("m/a");
  expect(stepAttention(order, "m/a", -1)?.key).toBe("m/c");
  expect(stepAttention(order, "m/a", 1)?.key).toBe("m/b");
});

test("from outside the list, next goes to the first and previous to the last", () => {
  const order = [row("m/a"), row("m/b")];
  expect(stepAttention(order, "m/elsewhere", 1)?.key).toBe("m/a");
  expect(stepAttention(order, null, -1)?.key).toBe("m/b");
});

test("with nobody waiting there is nowhere to go", () => {
  expect(stepAttention([], "m/a", 1)).toBeUndefined();
});
