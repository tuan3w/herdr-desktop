---
name: herdr-prototype
description: Build a throwaway, rendered prototype of herdr-desktop so a UI or UX question is discussed on pixels instead of words. Reproduce the complaint with today's code and realistic data, then draw 2 to 4 directions that each move one axis (a layout, a region, a density), render them side by side, and say which wins when and what it costs. Use it whenever the best path is unclear, the owner says "prototype", "mock it up", "show me", "compare options", "what would it look like", or before a non-trivial change to the window layout, the sidebar, the board or the chat's regions, even if they never say prototype.
---

# Prototyping herdr-desktop

A UI discussion in words stays vague: two people picture two screens. A prototype puts the same pixels in front of both, makes each option cheap to reject, and shows what words hid (a baseline that already looks fine, a variant that costs half the height). It is a tool for the conversation, not a step toward the product: nothing here ships.

Use it when the path is open. If the owner already chose, write the `herdr-design` plan table and implement.

## The method

1. **Pin the question** in the owner's words plus the moment. Example: "the chat is a narrow column in a big window; details are a text button; I can't see where it runs or what changed."
2. **Reproduce it from the code before drawing.** Trace each complaint to `file:line` (a value from `lib/layout.ts`, a component in `components/`). A complaint has several causes and a prototype that fixes the wrong one looks good and changes nothing. Quote the rule the project already states (`DESIGN.md`, `design/*.md`) with its number, and say what the screen is for today in one line.
3. **Teardown a reference** (`herdr-design` step 6) so the options are not invented from this app alone. Cite the screenshot.
4. **Pick the lowest rung.**

| Rung | What | Use when |
|---|---|---|
| 1. Stand-ins | Compose the screen from the kit (`#kit`) over plain records in a `*-lab.tsx` entry. Touches nothing else. | Layout, regions, information design. Most questions. |
| 2. Real screen on `seeded(name)` | The real component on the fake herdr. | The baseline must be real, or data alone shows the effect. |
| 3. Patched app in a throwaway worktree | Needs behaviour: resize, keyboard flow, motion. | Pixels cannot show it. |

5. **Draw directions that each move one axis**, named by the axis, not "A/B/C": *inspector open vs. details dialog*, *one-line sidebar rows vs. two-line*, *board beside the sidebar vs. instead of it*. Same data, same window size (1280 x 800 first, then 960 and 760). Include the baseline.
6. **Render** with `herdr-screen-check` (Linux, cairo under Xvfb; on a Mac mark it unverified and describe nothing you did not see).
7. **Critique before you choose**: hand the PNGs to `herdr-critic` without your pick.
8. **End with one line each**: when it wins, what it costs, what would flip it. The owner chooses.

## Rules

- Put prototypes under `.scratch/` or an `*-lab.tsx` entry; delete what you do not promote. Never commit screenshots (`AGENTS.md`).
- Synthetic data only; never a real pane.
- Do not touch the user's live herdr: use the fake server, or a scratch workspace labelled `herdr-desktop-scratch`.
- Do not kill a process you did not start.
