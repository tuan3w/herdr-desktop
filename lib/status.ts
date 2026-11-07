/** What herdr reports for an agent (`agent_status`), the same five values as `docs/herdr-api.schema.json`. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The words for a status, for labels and the status line: what the person needs to do, not herdr's word. */
export function statusText(status: AgentStatus, reviewed = false): string {
  switch (status) {
    case "blocked":
      return "needs you";
    case "working":
      return "working";
    case "done":
      return reviewed ? "done, reviewed" : "done, to review";
    case "idle":
      return "idle";
    case "unknown":
      return "status unknown";
  }
}

/**
 * The quiet word a row says for a state, in its meta line: the shape is small and muted, so the word carries what the colour
 * no longer shouts. Empty for idle and unknown (a row that does nothing says nothing).
 */
export function stateWord(status: AgentStatus, reviewed = false): string {
  switch (status) {
    case "blocked":
      return "waiting for you";
    case "working":
      return "working";
    case "done":
      return reviewed ? "done" : "done, to review";
    case "idle":
    case "unknown":
      return "";
  }
}
