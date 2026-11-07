import type { QueuedView, SessionView } from "herdr-desktop/native";

/**
 * The rules of the chat's message box that are about the conversation, pure: what a send does while the agent works,
 * how a message taken back from the queue lands in the box. What the box holds (mentions, pictures, pastes) is
 * `lib/composer-refs.ts`; the box itself is `components/session-composer.tsx`.
 */

/** What sending now does, said before it is done: nothing while the message would simply go. */
export function deliveryNote(view: Pick<SessionView, "running" | "queue">): string | null {
  if (view.running) return "Goes into the queue and is sent when the turn ends. Esc stops the turn.";
  if (view.queue.length > 0) return "Messages already waiting go first, in order.";
  return null;
}

/** Why queued messages are held (the turn failed), when any is: `releaseQueue` lets them go. */
export const heldReason = (queue: readonly QueuedView[]): string | null => queue.find((q) => q.held)?.held ?? null;

/** A message taken back from the queue lands after what is already typed, on its own line: nothing typed is lost. */
export function restoreText(typed: string, taken: string): string {
  return typed.trim() === "" ? taken : `${taken}\n${typed}`;
}

/** Most files and folders one message carries, attached and mentioned together. */
export const MAX_FILES = 20;

/** `report.pdf` for `/home/me/report.pdf`. */
export const fileName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;
