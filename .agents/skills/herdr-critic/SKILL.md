---
name: herdr-critic
description: An independent design critique of rendered herdr-desktop windows or a prototype, done by a fresh reviewer who sees only the pixels, the person's moment and the project's rules, never the builder's pick. Use it before presenting prototype directions to the owner, after a UI change was rendered, and whenever someone asks for a critique, a second opinion, "what's wrong with this", "why does this look bad", "which one is better" or a comparison with another app's screenshots, even if they don't say critic. It exists because the person who built a design is the worst judge of it.
---

# Critiquing a design

Whoever built a screen has already decided it works. They know what each row means and which variant they like, so they read the pixels with that knowledge and miss what a person opening the window would not see. A critique is useful only from someone with none of it. So the method keeps the critic's view clean, then uses what it says.

`herdr-design` decides what the design should be, `herdr-prototype` makes the options, `herdr-screen-check` proves the chosen one at every size. The critic runs between: after the pixels exist, before anyone is told which is best.

## 1. Give the critic only what a user would have

Pass: the PNG paths (window screenshots, 1280 x 800 first), one sentence for the moment ("second monitor, 6 agents running, glancing to see which needs me"), the five questions from `herdr-design`, and the rules to judge by: `DESIGN.md` and the `emil-design-foundations` checklist.

Withhold: your recommendation, which variant is "today", and which fields are stand-ins, until its first reading is written. Then tell it the baseline and the stand-ins and ask it to re-read. A finding that exists only because a stand-in is cruder than the real widget is the builder's artefact: drop it and say so.

When the question is "why is this worse than app X", also pass **X's screenshot**, unlabelled as better or worse, and ask for a region-by-region comparison.

Spawn it as a read-only subagent so its context is fresh. Put in its task text: it must not edit files; it must not kill any process; it cites a PNG for every finding; it never opens, logs or reproduces a real pane (fixtures are synthetic).

## 2. What the critic does, in order

1. **Glance test, per image, first.** In three seconds: what needs me? what is each row? which would I open first? Write the answers down. Where it cannot say what a row is, that is the finding.
2. **Regions.** Name what each region is for (sidebar, main, inspector, status). Is any region empty, duplicated by another, or doing another's job? How much of the window is content, and how much is margin?
3. **Density.** How many agents are visible without scrolling? How many pixels does one agent cost? Is a row two lines of mostly identical text?
4. **Said once.** Count the marks for one fact (a waiting agent: sidebar badge, dot, section, card, summary strip, status bar). More than one per view is a finding (`design/attention.md`).
5. **Five questions, per variant.** Which each answers faster or slower than today, and at what cost (clicks, reading, height, risk).
6. **Truth and safety.** Is anything shown that the app may not know (stale drawn as live)? Is the approved thing shown whole, never cut by an ellipsis?
7. **Rules, as far as pixels show.** Foundations (hierarchy, one primary action, nested radii, hairlines, alignment, tabular figures), type scale, contrast, status by shape and colour, hit targets, no raw id where a name exists. Say "from code, not seen" for the rest.
8. **Steel-man the baseline.** What does today do well that a variant loses?
9. **Rank, then say what would flip it.**

## 3. What comes back

Findings, worst first: `| # | Severity | Region / step | What the person experiences | Why it matters | Change | PNG |`. Severity: Broken, Friction, Noise, Inconsistent, Polish. Then the glance answers, the region table, the ranking, what the builder probably missed, and decisions with more than one right answer. Ten findings that matter beat thirty.

## 4. Use it honestly

Compare the critic's ranking with yours. If they differ, say so and say why you stand or move. A finding you disagree with goes under "decisions for the owner" with both views. A critique cannot judge feel, motion, keyboard flow or whether the real data exists: name those unchecked.
