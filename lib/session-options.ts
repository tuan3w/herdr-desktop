import type { ModeRiskName } from "herdr-desktop/native";

/** How far each mode lowers the agent's guard, in order. */
const RANK: Record<ModeRiskName, number> = { none: 0, elevated: 1, dangerous: 2 };

/** What a mode that lowers the guard is called in a title, and what it does in a sentence. */
export const RISK_WORDS: Partial<Record<ModeRiskName, { tag: string; why: string }>> = {
  elevated: { tag: "fewer checks", why: "the agent asks less often before it acts" },
  dangerous: { tag: "no checks", why: "the agent acts without asking" },
};

/**
 * Whether switching from a mode of risk `from` to one of risk `to` takes two presses: only a switch that lowers the
 * guard further does. Going back to a safer mode, or between equally safe ones, is one press.
 */
export function lowersGuard(from: ModeRiskName, to: ModeRiskName): boolean {
  return RANK[to] > RANK[from];
}
