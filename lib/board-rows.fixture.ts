import type { BoardData, BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";

/** Plain board data for the pure tests of the home, the sidebar and bulk actions: nothing here talks to the engine. */

/** A row `<machine>/<pane>` in project `project`, working unless `over` says otherwise. */
export function row(key: string, over: Partial<BoardRow> = {}): BoardRow {
  const [machine, paneId] = key.split("/");
  return {
    key,
    machine,
    machineName: machine === "local" ? "This computer" : machine,
    paneId,
    session: false,
    workspaceId: "w1",
    tabId: "w1:t1",
    project: `${machine}/workspace:p`,
    agent: "claude",
    name: `agent ${paneId}`,
    status: "working",
    offline: false,
    reviewed: false,
    reviewKey: `${key}|1`,
    preview: [],
    ...over,
  };
}

/** A project with `rows`; its counts are worked out from them, as the engine does. */
export function project(name: string, rows: BoardRow[], over: Partial<BoardProject> = {}): BoardProject {
  const machine = rows[0]?.machine ?? "local";
  const live = rows.filter((r) => !r.offline);
  const count = (status: string) => live.filter((r) => r.status === status).length;
  return {
    key: `${machine}/workspace:${name}`,
    name,
    machine,
    machineName: machine === "local" ? "This computer" : machine,
    pinned: false,
    offline: rows.some((r) => r.offline),
    checkouts: [],
    needsYou: count("blocked"),
    toReview: count("done"),
    working: count("working"),
    rows: rows.map((r) => ({ ...r, project: `${machine}/workspace:${name}` })),
    ...over,
  };
}

/** Board data with `projects`; the rows that need you are listed in `needsYou` too, as the engine does. */
export function boardData(projects: BoardProject[], over: Partial<BoardData> = {}): BoardData {
  const rows = projects.flatMap((p) => p.rows);
  const live = rows.filter((r) => !r.offline);
  const count = (status: string) => live.filter((r) => r.status === status).length;
  return {
    projects,
    needsYou: rows.filter((r) => r.status === "blocked"),
    counts: {
      needsYou: count("blocked"),
      toReview: count("done"),
      working: count("working"),
      idle: count("idle") + count("unknown"),
      offline: rows.length - live.length,
      machinesNotConnected: 0,
    },
    statusLine: "",
    title: "Herdr Desktop",
    revision: 1,
    ...over,
  };
}

/** A machine's status; online unless `over` says otherwise. */
export function machine(id: string, over: Partial<MachineStatus> = {}): MachineStatus {
  return {
    id,
    name: id === "local" ? "This computer" : id,
    state: "online",
    newerHerdr: false,
    agents: 0,
    needsYou: 0,
    ...over,
  };
}
