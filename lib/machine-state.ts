import type { LinkStateName, MachineStatus } from "herdr-desktop/native";
import type { AgentStatus } from "./status";

/**
 * The shape (`StatusGlyph`) that stands for a machine's link, so colour is never the only signal: online is the check,
 * connecting the half ring, offline the dashed ring, needs attention the filled disc with a bar, switched off the empty ring.
 */
export function linkGlyph(state: LinkStateName): AgentStatus {
  switch (state) {
    case "online":
      return "done";
    case "connecting":
      return "working";
    case "offline":
      return "unknown";
    case "attention":
      return "blocked";
    case "off":
      return "idle";
  }
}

/** The link in words, as the machine list and the sidebar say it: what is wrong and what happens next, never herdr's own terms. */
export function linkText(status: MachineStatus): string {
  switch (status.state) {
    case "online":
      return status.herdrVersion ? `Connected · herdr ${status.herdrVersion}` : "Connected";
    case "connecting":
      return "Connecting…";
    case "attention":
      return `Needs attention: ${status.detail ?? "check the connection"}`;
    case "off":
      return "Switched off";
    case "offline": {
      const why = status.detail ? `Not connected: ${status.detail}` : "Not connected";
      return status.retryInSecs !== null && status.retryInSecs !== undefined ? `${why} · reconnecting in ${status.retryInSecs} s` : why;
    }
  }
}
