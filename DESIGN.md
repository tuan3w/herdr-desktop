# herdr-desktop design

A quiet, dense, keyboard-first desktop tool for someone supervising coding agents all day. It looks like a page, not a dashboard: one surface, a sidebar one shade off it, text in two greys, hairlines instead of boxes, and colour spent only where it means something. The loudest thing on any screen is what needs the person; everything else is quiet and nothing moves at rest.

The kit-level rules (colours, themes, controls, menus, overlays, dialogs, forms, tables, motion) arrive with the UI kit in `design/`, copied from ship-desk and migrated to nsh 0.4.0. Until a file exists here, there is nothing to read for it.

## Rules

1. **Semantic tokens only.** Colour is a token class; terminal colours are `term-*` tokens and the only palette that is not a UI colour.
2. **Status is a shape first.** Needs you = filled with bar, working = half, done = check, idle = empty ring, unknown = dashed ring. Colour is never the only signal.
3. **Every control has a name.** Icon-only controls carry an accessibility label without a role word.
4. **Focus is always visible** and reachable by Tab in a logical order; no keyboard trap.
5. **Nothing is approved silently.** A risky answer is two-step, never a timed hold.
