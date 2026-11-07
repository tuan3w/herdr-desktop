import type { BoardRow } from "herdr-desktop/native";

export type BulkAction = "stop" | "message" | "close";

/**
 * What a bulk action (Stop, Message, Close) would do to the agents picked, worked out from live rows each time the
 * confirm dialog draws and again when its button is pressed: an agent that started waiting meanwhile is not typed into.
 *
 * An agent waiting on a question is skipped: a Stop or a message typed into a permission menu could answer it. The
 * person may include them with `Send anyway` (off by default); an agent on a machine that is not connected cannot be
 * reached at all.
 */
export interface BulkPlan {
  /** Agents the action reaches, in the order they were picked. */
  targets: BoardRow[];
  /** Agents blocked on a question: skipped, unless `sendAnyway` put them in `targets`. */
  waiting: BoardRow[];
  /** Agents whose machine is not connected: always skipped. */
  offline: BoardRow[];
}

export function planBulk(rows: readonly BoardRow[], sendAnyway: boolean): BulkPlan {
  const plan: BulkPlan = { targets: [], waiting: [], offline: [] };
  for (const row of rows) {
    if (row.offline) plan.offline.push(row);
    else if (row.status === "blocked") {
      plan.waiting.push(row);
      if (sendAnyway) plan.targets.push(row);
    } else plan.targets.push(row);
  }
  return plan;
}

/** `1 agent`, `3 agents`. */
export const agentsText = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
