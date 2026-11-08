---
name: herdr-critic
description: An independent, blind design critique of rendered herdr-desktop windows or a prototype, done by a fresh reviewer who sees only the PNGs, the person's moment and the five questions, never the builder's pick or reasoning. Use it before presenting prototype directions to the owner, after a UI change was rendered, and whenever someone asks for a critique, a second opinion, "what's wrong with this", "tear it apart", "why does this look bad", "which one is better", a design review of screenshots or a comparison with another app's screenshots, even if they never say critic. It exists because the person who built a design is the worst judge of it.
---

# Critiquing a design

Whoever built a screen has already decided it works. They know what each row means, which variant they like and why, so they read the pixels with that knowledge and miss what a person opening the window would not see. A critique is useful only from someone with none of it. So the whole method is about keeping the critic's view clean, then using what it says.

`herdr-design` decides what the design should be, `herdr-prototype` makes the options, `herdr-screen-check` renders them at every size, **the critic judges the pixels**, `herdr-review` judges the diff. The critic runs after the PNGs exist and before anyone is told which is best.

## 1. Keep it blind: give the critic only what a user would have

**Pass** (and nothing else):

- the PNG paths (window screenshots, 1280 x 800 first, then 960 and 760, light and dark);
- one sentence for the moment ("second monitor, 6 agents running across two machines, glancing to see which needs me");
- the five questions from `herdr-design` (needs me, alive, what did it do, steer, trust);
- the rules to judge by: `DESIGN.md` (read it whole: the quiet look, the closed lists), `design/attention.md` and the `emil-design-foundations` checklist.

**Withhold until its first reading is written:** your recommendation, your reasoning, which render is "today" and which fields are stand-ins or invented, the file names that give it away (rename PNGs `a.png`, `b.png`), the owner's complaint. Knowing the winner makes a critic look for reasons to agree.

**Then** tell it which render is the baseline and what is a stand-in, and ask it to re-read. Comparing against today is part of the job. A finding that exists only because a stand-in is cruder than the real widget (a cut command on a plain row where the real dock shows it whole) is the builder's artefact: drop it and say in the report that you did.

When the question is "why is this worse than app X", also pass **X's screenshot**, unlabelled as better or worse, and ask for a region-by-region comparison.

**Spawn it as a read-only fresh subagent** (not a fork: a fork inherits your context and is no longer blind). Put these lines in its task text:

- It must not edit files and must not run anything that changes the repo.
- It must not kill any process (`AGENTS.md`: never kill a process you did not start).
- It may open only the PNGs and the named rule files. It must not run the app, `nsh test`, `make shots` or any script (an `nsh test` without `HERDR_DESKTOP_TEST=1` reads the owner's real herdr and machines).
- It cites a PNG for every finding; it never opens, logs or reproduces a real pane (fixtures are synthetic).

If you have no subagents, do the pass yourself: write the glance-test answers down before you reread your own report, and say in the report that the critic was not independent.

## 2. What the critic does, in order

1. **Glance test, per image, first.** In three seconds, write down: what needs me? what is each row? which would I open first? Where it cannot say what a row is, that is the finding, and it is more reliable than any rule.
2. **Regions.** Name what each region (sidebar, main, inspector, status) is for in this image. Is any empty, duplicated by another, or doing another's job? How much of the window width is content and how much is margin or dead space? Is a text button standing in for a missing inspector?
3. **Density.** How many agents are visible in the sidebar without scrolling? How many points does one agent cost? Is a row two lines of mostly identical text? Does the open conversation keep a readable measure (720 to 768 pt) and is the surplus used?
4. **Said once.** Count the marks for one fact (a waiting agent: row mark, tab dot, header word, status-bar count, card, section, summary strip). More than one per view is a finding (`design/attention.md`). Count the colours that shout: there should be one thing loud.
5. **Five questions, per variant.** Which each answers faster or slower than today, at what cost (clicks, reading, height, risk).
6. **Truth and safety.** Is anything shown that the app may not know (a stale machine drawn as live, a saved copy as current)? Is the thing about to be approved shown whole, never cut by an ellipsis? Is the risky answer visibly different from the safe one, by shape and word, not only colour?
7. **Rules, as far as pixels show.** Hierarchy and one primary action, nested radii, hairlines, alignment of edges across stacked bars, type scale and tabular figures, contrast of muted text, status by shape then word then colour, hit targets, focus visible, no raw id where a name exists, two neutrals where one was meant. Say "from code, not seen" for the rest.
8. **Steel-man the baseline.** What does today do well that a variant loses? A list that got shorter may have hidden what it should show.
9. **Rank, then say what would flip it.** Without being told the builder's pick, order the variants and give the one fact that would change the order.

## 3. What comes back

Findings, worst first, in `herdr-design`'s form:

| # | Severity | Region / step | What the person experiences | Why it matters | Change | PNG |
|---|---|---|---|---|---|---|

Severity: Broken, Friction, Noise, Inconsistent, Polish. Then the glance answers, a region table (region, job today, what the image shows, verdict), the ranking, what the builder probably missed, and the decisions that have more than one right answer. Default to flagging; praise only what should not be "fixed". Ten findings that matter beat thirty.

## 4. Use it honestly

Compare the critic's ranking with yours. If they differ, say so in the report and say why you stand or move. Record at least one thing that changed because of the critique. Never drop a finding because it is inconvenient: one you disagree with goes under "decisions for the owner" with both views.

A critique cannot judge feel, motion, keyboard flow, focus order, real data or a real monitor. Name those as unchecked. It also cannot judge a render that was not made: on macOS the shots come from `make shots-mac` (the window only; popups and menus are not in them, shadows are not faithful, `Inter` is replaced by the system font); say which of these the critic could not see.

## Never / Instead

| Never | Instead |
|---|---|
| Fork yourself as the critic | A fresh subagent given PNGs and questions only |
| Name the winner, the baseline or the stand-ins in the first brief | Reveal them after its first reading |
| Let it run the app to "see more" | Give it more PNGs (states, widths, themes) |
| Keep only the findings you agree with | Report disagreements as decisions for the owner |
| Judge pixels you did not open | Count the PNGs the critic opened and name the unseen states |
