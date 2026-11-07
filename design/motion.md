# Motion

Motion explains a change: something arrives, folds, finishes, moves. It is short, eased out, never decorative, and never between the person's key and the result of the key. Everything is `lib/motion.ts`; do not write a duration, easing or `transition*` anywhere else. An app at rest draws no frames: nothing here loops except `Spinner` and `Skeleton` while they are on screen, and everything honours `reducedMotion()`.

## What moves

| Thing | Motion | Duration, easing | Helper | Reduced motion |
|---|---|---|---|---|
| `Btn` pressed | scale to 0.96 and back, from the current value (interruptible) | `press` 120, `EASE_OUT` | `pressFeedback()` | none |
| Hover and selected fills (rows, tabs, controls) | colour eases | `hover` 150, ease-out | `hoverTransition()`, `pressTransition()` | none |
| A project card, an agent's row, a tab's face, the `New messages` pill, the first time each is built | fade in, rise `RISE` (8 pt) | `rise` 240, `EASE_OUT` | `appear(key)` | none |
| A line of the chat arriving (a message, a tool, the lines a `Worked for` group opens) | fade in, rise 8 pt; the content moves, never the recycled cell | `rise` 240, `EASE_OUT` | `arrivals()`, `arriving()` in `SessionRow` | none |
| A project card folds or unfolds, `3 more idle` opens, the inbox appears or goes | what was inserted fades in, what moved glides, what was removed fades out (a layout animation of the commit); the inbox arriving or going is this, and so is every removal: nothing keeps a removed view mounted to play an exit | `fold` 220, ease-in-out; fade out ease-in | `animateLayout()` | none |
| A number changes (the counts of the status bar, the inbox, the status line, the Board count) | new text fades in and rises 4 pt | `swap` 160, `EASE_OUT` | `Swap` (kit) | none |
| An agent's state glyph changes (same agent, new state) | grows back from 0.5 with a fade | `pop` 160, `EASE_OUT` | `glyphChanged()` in `StatusGlyph` | none |
| A popover (a rail tile's agents) opens | fade, scale from `ENTER_SCALE`, 4 pt away from its trigger | `enter` 220, `EASE_OUT` | `popupEnter()` | none |
| Dialog | popup scales 0.97 to 1; layer and scrim fade (nsh-owned) | `enter` 220, `EASE_OUT` | `enterScale()` in `Modal` | scale none; nsh's fade follows only the system setting |
| Check mark of a `CheckRow` | pops in from 0.4 | `pop` 160 | `createMotion` | nsh-owned |
| `Switch` thumb | slides | `pop` 160, ease-out, `transform` only | `moveTransition()` | none |
| `Collapsible` chevron | turns | `pop` 160 | `moveTransition()` | none |
| `Spinner`, `Skeleton` | endless turn / breath while mounted | 800 linear / 1400 ease-in-out | `createMotion` | still |
| A project is shown in place of another (`mod+shift+]`, the Switcher, an agent of another project) | the incoming workspace fades from 0.88 to 1; no fade-out, skipped when repeated within 400 ms | `context` 120, `EASE_OUT` | `contextEnter()` in `Workspace` | none |
| Toasts | enter, stack, swipe and exit are the `ToastStack` springs (nsh-owned) | nsh | `ToastHost` | nsh |

`motionReady` is set 600 ms after the app's first screen. What is on screen when the window opens, and what a restored layout builds, does not move: only what arrives afterwards does. The first look at a conversation settles for 500 ms before `arrivals` lets a line move, for the same reason.

## What never moves

| Thing | Why |
|---|---|
| Switching tabs inside a context, and Home (`⌘1`, `⌘⇧1` to `⌘⇧9`, the sidebar), tab content | keyboard-driven and repeated all day: a transition is a delay |
| Anything a keyboard shortcut does, except opening a dialog | the person already knows what will happen |
| `ActionMenu` and `RowMenu` popups, comboboxes, selects, tooltips | they open and move their highlight at once |
| The live pane mirror (`PaneScreen`) | it is data, drawn as it comes |
| The sidebar's own fold, its rows | a virtual list whose cells are recycled: animating them fights recycling |
| Streaming text in a message | the row is the same line; only its first arrival moves, so text growing never replays |
| The working glyph | an endless turn would keep the app drawing every frame for as long as any agent works (hours): the glyph changes shape when the state changes (`pop`) and is otherwise still |
| Progress width, the keyboard focus ring, row actions that appear on hover | layout, and feedback that must be instant |
| Switching theme | a whole-window repaint of every colour at once is not a change worth watching |

## Values

| Name | Value | Used for |
|---|---|---|
| `DURATION.press` | 120 ms | `Btn` press |
| `DURATION.hover` | 150 ms | hover and selected fills |
| `DURATION.pop` | 160 ms | a glyph, a check mark, a thumb |
| `DURATION.swap` | 160 ms | a changed number |
| `DURATION.enter` | 220 ms | a dialog, a popover |
| `DURATION.exit` | 160 ms | reserved: the exits that exist are nsh's (dialog fade, toasts, a layout animation's removals) |
| `DURATION.fold` | 220 ms | `animateLayout()` |
| `DURATION.rise` | 240 ms | a thing arriving |
| `EASE_OUT` | `[0.32, 0.72, 0, 1]` | everything that enters or is pressed |
| `RISE` | 8 pt | travel of an arrival |
| `PRESS_SCALE` / `ENTER_SCALE` | 0.96 / 0.97 | pressed `Btn` / start of a dialog or popover; never from 0 |

Exits are about 25% quieter than enters; no bounce anywhere; a motion that is interrupted (a card folded and unfolded within 200 ms, a count that changes twice) retargets from where it is, because each one is an `Animated` value or a `createMotion` and not a timeline.

## Rules

1. Animate only `transform`, `opacity` and colours. A height or a position moves only through `animateLayout()`, which asks the engine to animate the commit's frames.
2. `transitionProperty` is always named (`"colors"`), never `"all"`.
3. Every new motion goes through a helper in `lib/motion.ts`, or through `createMotion`, and does nothing under `reducedMotion()` (the system's request, or Settings > Reduce motion). A screen never reads nsh's `reduceMotion()`. Limit: nsh applies only the system setting to `motion-reduce:` classes, its own `Dialog` fade and a `createMotion` `enter` (the `CheckRow` tick).
4. A thing that arrives inside a virtual list (`List`) animates its content through `arrivals()`, decided per key, never per cell. A thing in an `Each` list (the home) uses `appear()`: building it is arriving.
5. A loop is created only while it is on screen, inside an `If`, and stopped with `cleanup`. No new loop for an agent's state.
6. Entrances use `EASE_OUT`, never `ease-in` (it starts slow); the only `ease-in` is the removal half of `animateLayout()`.

## Adding motion

1. Is it pointer-triggered or an arrival, and rare enough to be noticed? If a key repeats it or it happens 100 times a day, stop.
2. Add the value and helper to `lib/motion.ts`, a no-op under `reducedMotion()`, and a row to the table above.
3. Test the reduced-motion path: `open("./App.tsx", { ...DESKTOP, reducedMotion: true })`.
4. Look at it with `nsh test --trace` (the `Timing` and layout-animation ops appear under the step) and check `bun scripts/perf.mjs` still draws no frames at rest.

## What was verified

- `nsh test --trace`: switching from an agent's tab back to the home starts no `Timing` (a key built before is not an arrival: `appear(key)` remembers it).
- The idle rows of `bun scripts/perf.mjs` (`idle board`, `idle pane`, `idle pane after streaming`) draw 0 s with these motions in the app.
- Not verified: motion mid-flight (a screenshot cannot show it and the headless harness finishes native animations at once), the real GPU, and reduced motion under a real system setting; the tab face's and the pill's rise were not looked at in a trace.
