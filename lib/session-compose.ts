import type { QueuedView } from "herdr-desktop/native";

/**
 * The rules of the chat's message box that are about the conversation, pure: why the queue is held, how a message taken
 * back from the queue lands in the box. What the box holds (mentions, pictures, pastes) is `lib/composer-refs.ts`; the
 * box itself is `components/session-composer.tsx`.
 */

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
