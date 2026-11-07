# Accessibility

herdr-desktop is accessible first: a screen reader user, a keyboard-only user, someone at 200% text size or with reduced motion supervises agents with the same confidence as anyone else. Each rule below is mechanical enough to check; `design/controls.md` holds the kit-level form of them, `make a11y` the automated gate (AT-SPI tree, no unnamed control) once the harness exists.

## Rules

1. **Every control has a name.** Text buttons carry their label; an icon-only control is `IconButton` with a required `label`; inputs carry `accessibilityLabel` (`Field` sets it); a `Switch` and an `ActionMenu` take a `label`. The name is the thing, never the role: `Close`, not `Close button`; the role comes from nsh's role list (`AccessibilityRole`: `button`, `checkbox`, `switch`, `tab`, `tablist`, `listbox`, `option`, `combobox`, `menuitem`, `radio`, `spinbutton`, `progressbar`, `row`, `header`, `region`, `group`, ...). A glyph (`✕`, `▾`) is never a name: use `Icon`.
2. **State is a state, not a colour.** `accessibilityState` carries `selected`, `expanded`, `checked`, `disabled`, `busy`; where nsh has no state (`required`, `invalid`, `read only`) the kit appends it to `accessibilityHint`. A pressed toggle is `checked` or `selected`, never only a darker fill.
3. **Colour is never the only signal.** Agent status is a shape first, then a word, then a colour:

   | Status | Shape | Word |
   |---|---|---|
   | needs you (`blocked`) | filled circle with a bar | `Needs you` |
   | working | half-filled circle | `Working` |
   | done | check | `Done` |
   | idle | empty ring | `Idle` |
   | unknown | dashed ring | `Unknown` |

   An error is a red edge plus an icon plus text. The `Needs you` pill has a shape and text.
4. **Hit targets.** At least 24 x 24 css pt for a pointer (WCAG 2.2 AA, 2.5.8); 44 pt where touch is possible. A control drawn smaller keeps its target through padding or hit slop; dense rows are 28 pt or more.
5. **Focus is always visible** (`FOCUS_RING`, `FOCUS_RING_SIDEBAR`, `FOCUS_RING_INSET` from `components/kit/core.ts`, at least 3:1 against what it sits on: `lib/theme/theme.test.ts` checks the pairs). Tab order follows reading order; every popup, menu and dialog is left with Escape or its own close control; nothing traps the keyboard. A view cannot take the focus from code, so popups keep the focus on the trigger and move a highlight that is announced.
6. **Status is spoken, politely or assertively.** `announce(message)` is polite and is for what happens away from the focus: a toast, a result count after a filter, a state change that is not blocking. Something that blocks the person (an agent needs an answer, a link failed for good) is announced and the focus moves to the control that resolves it. Never announce on a timer or per output line: the opt-in `Announce agent output` setting speaks at most once per two seconds.
7. **Reduced motion.** `reduceMotion()` (from GTK's `gtk-enable-animations`) switches every transition off through `lib/motion.ts`; classes that move carry `motion-reduce:`. An app at rest draws nothing.
8. **Large text.** Layouts survive `fontScale()` 2.0 (from `gtk-xft-dpi`): nothing is clipped, nothing overlaps, rows grow, columns drop. A pane mirror scales its own font to fit and scrolls sideways rather than shrinking below a readable size.
9. **Contrast.** 4.5:1 for body text, 3:1 for UI components and focus rings, in all four themes and both appearances: `lib/theme/theme.test.ts` fails the build otherwise. Terminal colours (`term-*`) reach 4.5:1 on `term-bg` except the four remapped slots (black and bright black on dark panes, white and bright white on light ones), which the pane component moves to the nearest passing colour at render time.
10. **Keyboard first.** Every function has a key path. Drag has a command twin. Global shortcuts always carry `mod`, never `alt` (AltGr is Ctrl+Alt); `Escape` is never global, because agents need it, and is not how capture mode is left. They live once in `lib/shortcuts.ts`, are listed by `Ctrl+/` or `F1`, and `lib/shortcuts.test.ts` enforces the rules.

## What nsh gives on Linux (0.4.0)

- The backend is GTK 4: roles, labels, descriptions, values and states reach AT-SPI through `GtkAccessible`; `testID` is the widget name; `accessibilityElementsHidden` hides a subtree.
- Live regions are emulated with `gtk_accessible_announce`: `announce()` speaks, a changing region is not read by itself.
- **Not supported:** `accessible` grouping (children stay separate elements) and custom `accessibilityActions` (GTK has none). Nothing may depend on either: a grouped name goes in the label of the container, an action is a real button.
- `Ctrl+Q` and `F11` cannot be bound (nsh reserves them). `AltGr` layouts type with Ctrl+Alt, hence rule 10.
- Environment signals come from GTK and the XDG settings portal: font scale, reduce motion, colour scheme, and AT-SPI's `ScreenReaderEnabled`.

## Checks

| What | How |
|---|---|
| Names, roles, states | `nsh test` asserts `label:` selectors; end-to-end tests find controls only by accessibility label |
| Contrast | `lib/theme/theme.test.ts` (UI pairs and the terminal palette) |
| Shortcut rules | `lib/shortcuts.test.ts` |
| Keyboard behaviour of the kit | `components/*.test.tsx` drive the controls with `keyboard.press` |
| AT-SPI tree, no unnamed control | `make a11y` (added with the audit harness, Phase 1.8) |
| Real screen reader | the Orca checklist below, by hand, with a display |

## Manual Orca checklist

Run with `orca` under a real session (`GTK_A11Y=atspi`, the default) before a release and after changing a screen's structure.

1. Start the app with Orca running: the window title is read, including the count in `(N) Herdr Desktop` when agents need you.
2. Tab through the window once: every stop is announced with a name and a role; no stop says `unlabelled`, `button` alone, or a glyph.
3. Open the command palette: the field and the result list are announced, the count is read, arrows move through results with their names, Enter runs one, Escape closes and the focus returns to where it was.
4. Board: each agent is read as name, agent, status word, machine and age; the `Needs you` section comes first; reviewing an agent announces the change and an Undo.
5. A blocking prompt: when an agent starts to need you, Orca announces `<agent> needs you: <question>` without moving the focus; the answer dock reads the exact option labels and the full command; a risky option says what pressing again will do before it sends.
6. Pane tab: the mirror is a group named `Terminal, <agent> on <machine>`; rows are readable with the review keys; entering capture mode announces it once and the hint bar is readable; leaving works with the documented keys.
7. Dialogs: the title is read on open, the focus lands inside, Tab cycles inside and Escape leaves.
8. At 200% text size (`gsettings set org.gnome.desktop.interface text-scaling-factor 2.0`) nothing is clipped; with animations off (`gsettings set org.gnome.desktop.interface enable-animations false`) nothing moves.
9. Switch all four themes in light and dark: focus ring and `Needs you` are visible in each.

## Keyboard-only walk-through

Not written yet. This section is filled in during Phase 4, when the board, the answer dock, the pane tab and capture mode exist: it will walk Board, answer, pane, capture, leave, one key at a time, with what a screen reader says at each step.
