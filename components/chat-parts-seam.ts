import { Sessions } from "herdr-desktop/native";

/**
 * Ends every session the keeper of this computer holds. A keeper outlives the app by design, so a test or a screenshot
 * run that started a session must end it, or its python processes stay behind after the run. Only for `*.test.tsx` and
 * the screenshot scenarios: the seam's keeper lives in a home of its own, so these are the run's own sessions.
 */
export async function endSessions(): Promise<void> {
  const held = await Sessions.list("local").catch(() => []);
  for (const session of held) await Sessions.kill("local", session.id).catch(() => undefined);
}
