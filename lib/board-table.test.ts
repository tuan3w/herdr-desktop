import { expect, test } from "nsh/test";

import { boardData, machine, project, row } from "#lib/board-rows.fixture";
import { chipCount, inFilter, lastText, tableItems } from "#lib/board-table";
import type { BoardFilter, TableItem } from "#lib/board-table";
import { keepItems, sidebarItems } from "#lib/sidebar";

const one = [machine("local")];
const shape = (items: TableItem[]) =>
  items.map((i) => {
    switch (i.kind) {
      case "project":
        return `# ${i.project.name}${i.machine ? ` on ${i.machine}` : ""}${i.stale ? " (stale)" : ""}${i.folded ? ` (folded ${i.count})` : ""}`;
      case "row":
        return i.row.name;
      case "more":
        return `more ${i.count} ${i.open}`;
    }
  });
const table = (
  data: ReturnType<typeof boardData>,
  filter: BoardFilter = "all",
  folds: string[] = [],
  opened: string[] = [],
) => tableItems(data, one, filter, folds, opened);

const mixed = () =>
  boardData([
    project("api", [
      row("local/p1", { name: "asks", status: "blocked" }),
      row("local/p2", { name: "busy" }),
      row("local/p3", { name: "finished", status: "done" }),
      row("local/p4", { name: "quiet", status: "idle" }),
    ]),
    project("web", [row("local/p5", { name: "web busy" }), row("local/p6", { name: "web asks", status: "blocked" })]),
  ]);

test("the table lists the sidebar's projects, in the sidebar's order, with the same rows", () => {
  const board = boardData([
    project("zeta", [row("local/p1", { name: "z one" })], { pinned: true }),
    project("api", [row("local/p2", { name: "a one", status: "blocked" }), row("local/p3", { name: "a two" })]),
    project("lab", [row("lab/p4", { name: "far" })]),
  ]);
  const machines = [machine("local"), machine("lab")];
  const side = sidebarItems(board, machines, "", [], []);
  const flat = tableItems(board, machines, "all", [], []);
  const ids = (items: { kind: string; key: string }[]) => items.filter((i) => i.kind !== "checkout").map((i) => i.key);
  expect(ids(flat)).toEqual(ids(side));
});

test("a folded project is its header with how many agents it holds, and folds do not move other projects", () => {
  const board = mixed();
  const api = board.projects[0].key;
  expect(shape(table(board, "all", [api]))).toEqual(["# api (folded 4)", "# web", "web busy", "web asks"]);
});

test("a project on another machine names it, amber when that machine is not online, this computer is not named", () => {
  const board = boardData([project("api", [row("local/p1")]), project("api", [row("lab/p2", { name: "theirs" })])]);
  const items = tableItems(board, [machine("local"), machine("lab", { state: "offline" })], "all", [], []);
  expect(shape(items)).toEqual(["# api", "agent p1", "# api on lab (stale)", "theirs"]);
});

test("each chip keeps exactly the agents in that state and drops projects left empty", () => {
  const board = mixed();
  expect(shape(table(board, "blocked"))).toEqual(["# api", "asks", "# web", "web asks"]);
  expect(shape(table(board, "working"))).toEqual(["# api", "busy", "# web", "web busy"]);
  expect(shape(table(board, "done"))).toEqual(["# api", "finished"]);
  expect(shape(table(board, "idle"))).toEqual(["# api", "quiet"]);
});

test("the chips' counts are the engine's counts, and each equals what its filter lists", () => {
  const board = mixed();
  for (const filter of ["blocked", "working", "done", "idle"] as const) {
    const listed = table(board, filter).filter((i) => i.kind === "row").length;
    expect(chipCount(board.counts, filter)).toBe(listed);
  }
});

test("an agent on a machine that is not connected is listed but in no chip, as the counts say", () => {
  const board = boardData([
    project("api", [
      row("lab/p1", { name: "gone", status: "blocked", offline: true }),
      row("lab/p2", { name: "here" }),
    ]),
  ]);
  expect(shape(table(board, "all"))).toContain("gone");
  expect(shape(table(board, "blocked"))).toEqual([]);
  expect(chipCount(board.counts, "blocked")).toBe(0);
  expect(inFilter(board.projects[0].rows[0], "blocked")).toBe(false);
});

test("idle agents past the first few fold into one line, and the Idle chip lists them all", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: `idle ${n}`, status: "idle" }));
  const quiet = project("q", rows);
  expect(shape(table(boardData([quiet]))).slice(-2)).toEqual(["idle 3", "more 2 false"]);
  expect(shape(table(boardData([quiet]), "all", [], [quiet.key])).slice(-2)).toEqual(["idle 5", "more 2 true"]);
  const idle = shape(table(boardData([quiet]), "idle"));
  expect(idle).toEqual(["# q", "idle 1", "idle 2", "idle 3", "idle 4", "idle 5"]);
});

test("a blocked terminal's last text is its question's first line, a chat's is what the agent said", () => {
  const asking = row("local/p1", {
    status: "blocked",
    prompt: { question: "Do you want to proceed?\nsecond line", options: [], digest: "d" },
    lastMessage: "ignored",
  });
  expect(lastText(asking)).toBe("Do you want to proceed?");
  expect(lastText(row("local/p2", { session: true, lastMessage: "Ran the tests" }))).toBe("Ran the tests");
  expect(lastText(row("local/p3"))).toBe("");
});

test("an item that did not change keeps its identity across reads, so the list keeps its place", () => {
  const first = table(mixed());
  const second = keepItems(first, table(mixed()));
  expect(second.every((item, i) => item === first[i])).toBe(true);
  const board = mixed();
  board.projects[0].rows[1] = { ...board.projects[0].rows[1], name: "renamed" };
  const third = keepItems(first, table(board));
  const changed = third.filter((item, i) => item !== first[i]).map((i) => i.key);
  // The project line holds its rows, so it is new as well; every other line is the object it was.
  expect(changed).toEqual([`p:${board.projects[0].key}`, board.projects[0].rows[1].key]);
});
