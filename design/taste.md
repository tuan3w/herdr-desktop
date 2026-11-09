# Taste: the rules the owner keeps enforcing

Each rule below was a correction made while looking at a render, usually next to the Claude desktop app, which is the reference for calm. They apply to every screen and the kit. Check each one by eye in every render (`herdr-screen-check`); a rule that stops being true is edited here, with the reason, never worked around in a screen.

1. **Nothing jumps.** Hover, focus and an open menu never move, resize or re-truncate text. An action that appears on hover either has a slot reserved at rest (a header: 32 pt buttons, 2 pt apart; 44 pt under Large hit targets) or comes over the end of the text on a backing in the row's current fill (an agent row); only opacity changes, the text stays put. Why: a row that shifts under the pointer makes the person miss the press. Correct: `+` and `...` fade in inside a reserved right slot, or `...` fades in over a long title's tail. Incorrect: the header shrinks 64 pt on hover and the name becomes `herdr-...`.
2. **One surface per thing.** A header line, a row and a code block each have one surface and one hover. No box in a box, no chevron in its own pill, no strip behind a toolbar, no double edge (one hairline or one shadow ring, never both). Why: stacked fills read as three controls and show a seam.
3. **Text is whole, or it fades; never a stub.**

   ```
   Does name + machine fit at natural (measured) width?
    ├── Yes → show both whole
    └── No → drop the machine label entirely (never a stub), then shrink the name
              └── A clipped name fades over its last 24 pt (`Clipped` with `fade`); the full text is the tooltip and the accessible name
   ```

   Why: a stub like "fatm" tells the person nothing, and a cut that appears while 300 pt are free looks broken. The decision is `machineFits` in `lib/header-fit.ts`, from measured widths.
4. **Quiet at rest.** Copy buttons, row menus and block toolbars appear on hover or `focus-within` (still reachable by Tab) as 16 pt icons without a fill. One icon per block at most; every other setting sits behind one `...` menu. No filled chips for secondary actions.
5. **A tooltip covers nothing it explains and never leaves the window.** Visible text is at most 30 characters (the long form is the accessible name: `New session` shows, `New agent session in payments` is spoken). It is clamped 8 pt inside the window, opens above a control that sits on text or on a row, and never repeats a visible label (a button reading `Copy` has none).
6. **A toast never covers the composer or the answer dock.** Top right, 52 pt under the top edge, enters from above; plain 3.5 s, with Undo 10 s.
7. **Say it once.** A placeholder or a help line, never both. A failure appears once (the row, or the fold, or the effects line). One state mark per fact: no check on every row; success is silence.
8. **Targets you can hit, spaced.** 32 pt controls (28 only in a dense table row), radii nested (outer minus padding), one primary action per view.
9. **The steps between two sentences of the agent are one hairline card of rows at the size of the prose**: each row says what the step was for in the agent's words, else `Ran make test`, muted by colour, with a count and a chevron, and its marks at the right end; no icon in front, no check. Inside the card the only boxes are text you can copy: the opened step's command is one code block, and what it printed is plain lines. Why: the person reads the answer and the exceptions, not a log, and the Claude desktop app, which the owner prefers, frames the steps once and never each line.
10. **Hierarchy by subtraction.** The thing that needs the person is the only loud thing; everything else is a muted tone, not a smaller button. If two things are loud, demote one.
11. **One focus ring.** One thin 1.5 pt line in `ring`, hugging the control's own radius with no gap and no halo; a bordered control turns its own border `ring` (plus a 0.5 pt outline), a borderless one draws an outline at offset 0, rows draw it inside. Keyboard focus only (text fields on any focus). Why: owner decision 2026-11-08 ("just enough", after Linear's focus line): the earlier 2 pt ring floating 2 pt off the edge read as a thick detached outline, and a soft halo (tried, rendered) adds a second edge to fix a problem a crisp line does not have. A border recolour alone (1 pt) is too faint beside the neutral `input` border, hence the 0.5 pt outline.
