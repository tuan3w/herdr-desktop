import { splitFences } from "#lib/markdown-fences";
import type { Row } from "#lib/session-rows";
import { safeCode } from "#lib/visible-text";

/** The Markdown of the agent's last answer, as it was written; `undefined` when the agent has said nothing yet. */
export function lastReply(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "agent") return row.item.text ?? undefined;
  }
  return undefined;
}

/** The code of the last fenced block of `reply` (as `CodeBlock` shows it, so a copy is what was drawn); `undefined` when it has none. */
export function lastCode(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const fences = splitFences(reply).filter((s) => s.kind === "fence");
  const last = fences.at(-1);
  return last?.kind === "fence" ? safeCode(last.code) : undefined;
}
