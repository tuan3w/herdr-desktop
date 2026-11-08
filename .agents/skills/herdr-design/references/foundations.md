# Foundations behind herdr-design

General principles, translated for a dense desktop window. The repo's own numbers live in `lib/layout.ts` and `design/foundations.md`; do not copy them here or into a screen. The `emil-*` skills carry the detailed craft rules (written for the web: keep the value, translate the unit to nsh classes).

## What a supervisor window must do

- **Clarity over cleverness.** A row says what it is in one glance. If the person cannot say what a row is in three seconds, that is the finding (this is the critic's glance test).
- **Hierarchy by subtraction.** Remove before you style. One primary action per area, one loud thing per screen (what needs the person). Two greys and two weights (`DESIGN.md`, "The look: quiet").
- **Deference.** Chrome serves the conversation and the terminal. Bars stack into a tax: a tab strip, a header, a subagent panel and a sticky region together are four bars; merge or drop one.
- **Direct manipulation, with a keyboard.** Everything a pointer does has a key path and a name in the accessibility tree. Per-row actions appear on hover or focus and stay pressable.
- **Feedback at the point of action.** Press feedback is instant (`design/motion.md`). A result is said where the person looked (a toast with Undo, the dock leaving), never in a second place.
- **Consistency by construction.** One of each (dock, toast, palette, guard, switcher). Same object, same word. Same job, same pattern, same key.
- **Forgiveness.** Reversible edits get Undo; irreversible ones get a confirm built from live facts; risky answers are two-step. Never confirm the cheap.
- **Honesty.** Stale is stale, offline is offline. Never fake liveness; never draw a saved copy as live; never invent a field.
- **Calm.** Said once and quiet is not the same as empty. Unused width, oversized type and empty regions are defects. A screen full of attention marks is stress, not information.
- **Persistence.** The window stays open all day: restore layouts, drafts and scroll; keep a waiting question visible while they read Settings.

## Density and layout

- Row heights, gaps and radii sit on a 4-pt grid and the radius of a nested surface is the outer radius minus the padding (`emil-surfaces`).
- Heights are `min-h`, never `h`, so `fontScale()` 2.0 grows a row instead of cutting its text.
- A measure of 720 to 768 pt for reading; extra width goes to a second region.
- Three tested widths (1280, 960 with `snug()`, 760 with the rail) and `fontScale()` 2.0. A region is dropped on purpose at each.
- Numbers that change use tabular figures (`design/typography.md`). A label that changes width every second (`stale · 12s`) is a layout shift.

## Craft hand-offs

| Concern | Skill |
|---|---|
| hierarchy, spacing, one primary action, copy | `emil-design-foundations` |
| type scale, truncation, fonts, tabular figures | `emil-typography` |
| radii, hairlines, shadows, dark surfaces | `emil-surfaces` |
| colour, contrast, tokens, themes | `emil-color` |
| composer, fields, validation, buttons | `emil-forms-and-inputs` |
| the kit's API | `emil-component-design` |
| invisible details (hit areas, focus, layout shift, selection) | `emil-ui-polish` |
| keyboard, focus, reduced motion, hit targets | `emil-touch-and-accessibility`, `docs/ACCESSIBILITY.md` |
| should it move, and how | `herdr-motion`, `emil-animations` |
| speed, lists, frames | `emil-performance`, `docs/PERFORMANCE.md` |
| generic-AI tells in UI or copy | `emil-unslop-design`, `emil-unslop-writing` |
