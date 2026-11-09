# Motion

Motion explains a change: something arrives, folds, finishes, moves. It is short, eased out, never decorative, and never between the person's key and the result of the key. Everything is `lib/motion.ts`; do not write a duration, easing or `transition*` anywhere else. An app at rest draws no frames: nothing here loops except `Spinner` and `Skeleton` while they are on screen and the chat's live glyph while its turn runs, and everything honours `reducedMotion()`.

## The frequency rule

Ask how often it happens before how it moves. A keyboard action, or anything done 100 times a day, has no animation: speed is the feel. Occasional, pointer-made things (a popover, a dialog, a toast, a card arriving) animate, under 240 ms, an exit about a quarter quicker than its enter. `markKeyboard()` is called by the global shortcut handler before an action runs; for `KEY_WINDOW_MS` after it `arrived()` (so `appear()`) and `contextEnter()` stay still.

## What moves

| Thing | Motion | Duration, easing | Helper | Reduced motion |
|---|---|---|---|---|
| `Btn` pressed | scale to 0.96 and back, from the current value (interruptible) | `press` 100, `EASE_OUT` | `pressFeedback()` | none |
| Hover and selected fills, a segment's label colour | colour eases | `hover` 120, `EASE_OUT` | `hoverTransition()`, `pressTransition()` | none |
| A project card, an agent's row, the first time each is built | fade in, rise `RISE` (8 pt) | `rise` 200, `EASE_OUT` | `appear(key)` | none |
| A tab's face, the first time it is built | fade in only: tabs are made often | `context` 120, `EASE_OUT` | `appear(key, "fade")` | none |
| A line of the chat arriving | fade in, rise 8 pt; the content moves, never the recycled cell | `rise` 200, `EASE_OUT` | `arrivals()`, `arriving()` | none |
| The `New messages` pill | rises in; sinks out (stays built for the exit) | `rise` 200 in, `popupExit` 120 out | `leaving()` | none |
| A card folds, `3 more idle` opens, the inbox comes or goes, a `Collapsible` opens, an answer dock arrives | inserted fades in, moved glides, removed fades out (a layout animation of the commit); nothing else keeps a removed view mounted | `fold` 200, ease-in-out; fade out ease-in | `animateLayout()` | none |
| A number changes | new text fades in from 0.6 and rises 4 pt; not again within `SWAP_QUIET_MS` of the last change | `swap` 140, `EASE_OUT` | `Swap` (kit), `swapped()` | none |
| An agent's state glyph changes | grows back from 0.5 with a fade | `pop` 160, `EASE_OUT` | `glyphChanged()` | none |
| A popover opens and closes | fade and scale 0.96, from the edge at its trigger on the side it was placed; leaves the same way | `popup` 160 in, `popupExit` 120 out | `popupPresence()` | none, and no wait |
| Dialog | popup scales 0.97 to 1 and back; layer and scrim fade (nsh-owned, fixed 200) | `dialog` 200 both ways | `enterScale()` in `Modal` | scale none; nsh's fade follows only the system setting |
| The command palette opens | fades in and scales from 0.98; closing is instant | `context` 120, `EASE_OUT` | `paletteEnter()` | none |
| A toast | enters 12 pt below with a fade, leaves with a fade and shrink to 0.97; stack springs are nsh's | `toast` 200, `toastExit` 150 | `toastLook()` | none |
| Check mark of a `CheckRow` | pops in from 0.4 | `pop` 160 | `createMotion` | nsh-owned |
| `Switch` | knob slides on `transform`, track colour with it | `pop` 160, `EASE_MOVE` | `moveTransition()`, `trackTransition()` | none |
| `Collapsible` chevron | turns | `pop` 160, `EASE_MOVE` | `moveTransition()` | none |
| `Spinner`, `Skeleton` | endless turn / breath while mounted | 800 linear / 1400 ease-in-out | `createMotion` | still |
| The live line's half ring, at the end of a running turn (`design/chat.md`) | turns an eighth at a time, one turn in 2 s, while the agent was heard from within a minute, nothing waits for the person and the tab is in front; still otherwise; gone with the turn | ticker steps (every second step), no easing | `liveTurn()`, `turnClass()` | still (the ticker is not held), the clock still ticks |
| A project is shown in place of another by the pointer | the incoming workspace fades from 0.88 to 1; skipped when repeated within 400 ms or after a key | `context` 120, `EASE_OUT` | `contextEnter()` | none |

`motionReady` is set 600 ms after the app's first screen. What is on screen when the window opens, and what a restored layout builds, does not move: only what arrives afterwards does. The first look at a conversation settles for `SETTLE_MS` before `arrivals` lets a line move.

## What never moves

| Thing | Why |
|---|---|
| Switching tabs inside a context, Home, tab content | keyboard-driven and repeated all day: a transition is a delay |
| Anything a keyboard shortcut does, except opening a dialog | the person already knows what will happen |
| Rows of a live conversation | while a turn runs, and for more than 3 arrivals in a second, a line just appears; a code fence being written shows its last 12 lines, because a followed nested list holds full-rate frames (measured: 59 fps against 7) |
| `ActionMenu` and `RowMenu` popups, comboboxes, selects, tooltips, the preview card | opened and moved through many times a day: they open and close at once |
| The live pane mirror (`PaneScreen`) | it is data, drawn as it comes |
| The sidebar's own fold, its rows | a virtual list whose cells are recycled: animating them fights recycling |
| Streaming text in a message | only the line's first arrival moves, so growing text never replays |
| The working glyph of the sidebar, tabs and headers | an endless turn would keep the app drawing every frame for as long as any agent works, all day; only the chat's live line turns, in the one chat in front |
| Progress width, the focus ring, row actions that appear on hover | layout, and feedback that must be instant |
| Switching theme | a whole-window repaint at once is not a change worth watching |

## Values

| Name | Value | Why this number |
|---|---|---|
| `DURATION.press` | 100 ms | feedback must feel instant |
| `DURATION.hover` | 120 ms | a colour only, never in the pointer's way |
| `DURATION.swap` | 140 ms | enough to see which figure moved |
| `DURATION.pop` | 160 ms | a small part moving a short way |
| `DURATION.popup` / `popupExit` | 160 / 120 ms | a popover; exit 25% quicker |
| `DURATION.dialog` | 200 ms both ways | pairs with nsh's fixed 200 ms layer fade, which has no duration prop; the one exit not quicker |
| `DURATION.toast` / `toastExit` | 200 / 150 ms | bigger than a popover, still under 240 |
| `DURATION.fold`, `DURATION.rise` | 200 ms | layout glides and arrivals |
| `DURATION.context` | 120 ms | the quick fade of what is opened often |
| `EASE_OUT` | `[0.23, 1, 0.32, 1]` | strong: the start is fast, the answer is at once; enters and presses |
| `EASE_MOVE` | `[0.77, 0, 0.175, 1]` | for what is already on screen and moves |
| `EASE_IN` | `[0.4, 0, 1, 1]` | exits only: it starts slow, which is wrong for an answer |
| `RISE` | 8 pt | travel of an arrival |
| `PRESS_SCALE`, `POPOVER_SCALE`, `DIALOG_SCALE` | 0.96, 0.96, 0.97 | never from 0 and never under 0.95; bigger things move less |

nsh's style transitions take the curve as a `cubic-bezier(...)` string (read from nsh-core `style.rs`), so colour, press and knob transitions use these curves, not the weak named `ease-out`. No bounce anywhere. A motion that is interrupted retargets from where it is, because each one is an `AnimatedValue` or a `createMotion` and not a timeline; a popover reopened mid-exit turns around.

## Rules

1. Animate only `transform`, `opacity` and colours. A height or a position moves only through `animateLayout()`, which asks the engine to animate the commit's frames.
2. `transitionProperty` is always named (`"colors"`, `"transform"`), never `"all"`.
3. Every new motion goes through a helper in `lib/motion.ts`, or `createMotion`, and does nothing under `reducedMotion()`. A screen never reads nsh's `reduceMotion()`. Limit: nsh applies only the system setting to `motion-reduce:` classes, its `Dialog` fade and a `createMotion` `enter`.
4. A thing that arrives inside a virtual list (`List`) animates its content through `arrivals()`, per key, never per cell. A thing in an `Each` list uses `appear()`.
5. **No endless native animation, anywhere** (no `iterations: "infinite"`, no keyframe loop, no `animate-spin` or `animate-pulse`). nsh issue 958: one keeps the frame clock at the screen's rate (60 to 120 fps) and, with the window hidden, keeps the main thread ticking for ever; measured here, one 16 pt spinner took a static window from 0 fps to 60 and added 3 to 4% CPU. A looping indicator steps from the one shared timer of `components/kit/ticker.ts` (`useTicker`, 8 steps a second, no easing): it exists only while an indicator is mounted and while the window is not in the background (`lifecycle()`). `Skeleton` is still. `tickerRunning` is what `components/ticker.test.tsx` checks.
6. Enters use `EASE_OUT`, exits `EASE_IN`, things that move on screen `EASE_MOVE`. An exit of a popup is `presenceMotion` plus `createPresence`: the popup stays built for the exit, takes no presses, and a reopen cancels the unbuild.
7. Time and timers in tests go through `motionClock`; no motion test reads the real clock.

## Adding motion

1. Pointer-triggered or an arrival, and rare enough to be noticed? If a key repeats it or it happens 100 times a day, stop.
2. Add the value and helper to `lib/motion.ts`, a no-op under `reducedMotion()`, a row above, and a test in `lib/motion.test.ts`.
3. Test the reduced-motion path: `open("./App.tsx", { ...DESKTOP, reducedMotion: true })`.
4. Look at it with `nsh test --trace` and check `bun scripts/perf.mjs` still draws no frames at rest.

## Decided, not built yet

The inspector, when it exists, slides in on a horizontal translate at about 200 ms ease-out and out at 150 ms. It never animates when a keyboard shortcut toggles it. Instead of animating its width it uses a fade plus the layout animation, because a width tween is layout on every frame.

## What was verified

- Read, not run: nsh 0.4.0 accepts a `cubic-bezier(...)` string for `transitionTimingFunction`, `Animated.timing` retargets from the current value, the dialog fade is a fixed 200 ms, `Toast` has no look of its own, `View::follow` has no TSX face, `ElementRef::transition_time` is Rust-only.
- `lib/motion.test.ts` pins the reduced-motion paths, `appear`, `arrivals`, `contextEnter`, `swapped`, `createPresence` and `popupOrigin` with a fake clock.
- Not verified: `nsh check` and `nsh test` do not run on the installed nsh 0.3.0; motion mid-flight, the popover origin, the toast classes and the dialog scale-out in a real window; the layout animation of an arriving answer dock.
