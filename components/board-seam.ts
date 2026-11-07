import { Herdr } from "herdr-desktop/native";
import mixed from "../fixtures/herdr/mixed.json";
import projects from "../fixtures/herdr/projects.json";
import storm from "../fixtures/herdr/storm.json";

/** The command line of the fixtures' Claude Code permission screen; a test swaps it for another to change the question. */
const COMMAND = /touch \/tmp\/hm-capture-claude\/[^\s\u001b]+/;

type Name = "mixed" | "storm" | "projects";

/**
 * Test seam for the board's tests: moves the scripted herdr on from what `fixtures/herdr/<name>.json` shows, the way a
 * real agent does (asks something else, finishes, starts), and tells the app with an event. Only for `*.test.tsx`.
 */
export function scripted(name: Name) {
  const fixture = { mixed, storm, projects }[name];
  /** An idle agent of the fixture that `addIdle` copies (in the second workspace of `mixed`, in a project of its own in `projects`). */
  const template = name === "projects" ? "w5:p1" : "w2:p3";
  /** How many state episodes each pane moved on from the fixture's. */
  const episodes: Record<string, number> = {};
  const status: Record<string, string> = {};
  /** Idle agents added to the fixture's. */
  let extra = 0;
  const gone = new Set<string>();

  /** Publishes the fixture's snapshot with every change made so far, and says one pane changed. */
  function publish(pane: string) {
    const snapshot = JSON.parse(JSON.stringify(fixture.snapshot)) as typeof fixture.snapshot;
    for (const agent of snapshot.agents) {
      agent.state_change_seq += episodes[agent.pane_id] ?? 0;
      agent.agent_status = status[agent.pane_id] ?? agent.agent_status;
    }
    for (const p of snapshot.panes) p.agent_status = status[p.pane_id] ?? p.agent_status;
    snapshot.agents = snapshot.agents.filter((a) => !gone.has(a.pane_id));
    snapshot.panes = snapshot.panes.filter((p) => !gone.has(p.pane_id));
    const idle = snapshot.agents.find((a) => a.pane_id === template)!;
    const idlePane = snapshot.panes.find((p) => p.pane_id === template)!;
    for (let n = 1; n <= extra; n++) {
      const pane_id = `${template.split(":")[0]}:p${100 + n}`;
      snapshot.agents.push({ ...idle, pane_id, terminal_id: `t${pane_id}`, state_change_seq: n });
      snapshot.panes.push({ ...idlePane, pane_id, terminal_id: `t${pane_id}`, label: `extra idle ${n}` } as typeof idlePane);
    }
    Herdr.testSetSnapshot(snapshot);
    // Only a status event makes the link read the snapshot again: `state_change_seq` is not on a pane.
    const now = snapshot.agents.find((a) => a.pane_id === pane)?.agent_status ?? "idle";
    Herdr.testPush({ event: "pane_agent_status_changed", data: { pane_id: pane, agent_status: now } });
  }

  return {
    /** `count` more idle agents on top of the fixture's (named `extra idle 1`, ...). */
    addIdle(count: number) {
      extra = count;
      publish(template);
    },
    /** The agent in `pane` asks about `command` instead (a new episode: its question has a new digest). */
    ask(pane: string, command: string) {
      const rows = (fixture.panes as Record<string, { screen: string[] }>)[pane].screen;
      this.show(pane, rows.map((r) => r.replace(COMMAND, command)));
    },
    /** The pane shows `rows` from now on, as a new episode of the same state. */
    show(pane: string, rows: string[]) {
      episodes[pane] = (episodes[pane] ?? 0) + 1;
      Herdr.testSetScreen(pane, rows);
      publish(pane);
    },
    /** The pane is closed: its agent leaves the snapshot. */
    remove(pane: string) {
      gone.add(pane);
      publish(pane);
    },
    /** The agent in `pane` moves to another state (a new episode). */
    become(pane: string, next: "blocked" | "done" | "working" | "idle", rows?: string[]) {
      episodes[pane] = (episodes[pane] ?? 0) + 1;
      status[pane] = next;
      if (rows) Herdr.testSetScreen(pane, rows);
      publish(pane);
    },
  };
}

/** The keys sent to panes so far, as `pane: key key`, oldest first. */
export function sentKeys(): string[] {
  return Herdr.testRequests("pane.send_keys").map((r) => {
    const p = r.params as { pane_id: string; keys: string[] };
    return `${p.pane_id}: ${p.keys.join(" ")}`;
  });
}
