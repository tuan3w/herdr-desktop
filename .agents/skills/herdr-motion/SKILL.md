---
name: herdr-motion
description: How herdr-desktop moves and feels (nsh, TSX, GTK 4 and AppKit). Covers whether something should animate at all, the DURATION and EASE tokens and helpers in lib/motion.ts, popup and dialog enter and exit (createPresence, popupPresence, enterScale), toasts, arrivals and layout animation, nsh's transition classes, reduced motion, keyboard-driven actions that must not animate, and the rule that an app at rest draws no frames. Use it whenever you add or change an animation, transition, hover or press feedback, popover, dialog, toast, fold, arrival or loop, or ask to make something feel better, smoother, snappier or more alive, audit the motion, find where motion belongs, or name a motion effect, even if nobody says "animation". Use herdr-design for what a screen should do; herdr-motion covers how it should feel.
---

# Motion and feel in herdr-desktop

The person keeps this window open all day and uses the keyboard constantly. Motion has one job: help them follow what changed or feel that their action landed. Anything else is noise, and every frame drawn costs CPU on a machine that is also running agents. That is why the app is quiet: **an app at rest draws no frames**, a keyboard action never animates, and most changes are simply instant.

`design/motion.md` is the settled table of what moves and what never does, with every value and its reason; **`lib/motion.ts` is the source of truth for the numbers** (`DURATION`, `EASE_OUT`, `EASE_MOVE`, `EASE_IN`, `RISE`, `PRESS_SCALE`, `POPOVER_SCALE`, `DIALOG_SCALE`). Read both before touching motion; do not restate numbers elsewhere. The craft background is `emil-animations`; where it disagrees with `design/motion.md`, the repo wins. `DESIGN.md` rule 7 and `docs/ACCESSIBILITY.md` rule 7 apply.

## 1. Should it animate at all?

Answer first. Often the answer is no and you write no motion code.

| How often the person sees it | Decision | Examples here |
|---|---|---|
| Continuously, or driven by the agent rather than the person | Never animate. At most one settle when it changes on screen | streaming text, the pane mirror, elapsed times, board refresh, the working glyph (no endless turn; the one exception is the chat's live line, ticker-stepped and only while heard from: `design/motion.md`) |
| From the keyboard, or 100+ times a day | None, or a very short fade | tab switch, `mod+j`, `mod+e` switcher, menus, selects, tooltips, comboboxes (open and close at once) |
| Tens of times a day, by pointer | Fast and subtle | press feedback, hover fills, a project switched by pointer (`contextEnter`), the palette (120 ms, opens only) |
| Occasionally, by pointer | Standard, under 240 ms, exit about a quarter quicker | popover, dialog, toast, a card arriving, a fold, the answer dock arriving |
| Rarely, and meaning something | Delight is allowed, tiny | a check mark popping in |

Then name the purpose in one word. If you cannot, do not build it:

- **Feedback**: the action landed (press scale, hover colour).
- **Continuity**: where something came from or went (a popover growing from its trigger, a fold).
- **State change**: a change the person would otherwise miss (`glyphChanged`, `swapped`, an arrival).
- **Preventing a jump**: content would teleport (`animateLayout` for a dock appearing).

Two rules about what the person is reading or pressing: data being read never moves for style, and nothing appears or moves under the pointer and accepts a press at once (`GUARD_MS` of the answer dock exists for that; motion near a target must respect it).

**The keyboard rule.** `markKeyboard()` is called by the global shortcut handler (`App.tsx`) before an action runs; for `KEY_WINDOW_MS` (250) after it, `arrived()` (so `appear()`) and `contextEnter()` stay still. A shortcut's result never animates, except that opening a dialog may. Any new helper that reacts to a state change must honour this window or explain why not.

## 2. Pick the cheapest tool that works

1. **No animation.** An instant state change.
2. **A named transition on the element** (`pressTransition()`, `hoverTransition()`, `moveTransition()`, `trackTransition()`): `transitionProperty` is `"colors"` or `"transform"`, never `"all"`, with the curve as a `cubic-bezier(...)` string (nsh reads that; the named `ease-out` is the weak CSS curve).
3. **`pressFeedback()`** for press scale (`Btn` does it; `Button`'s `activeStyle` transform is ignored on the host, so drive scale with `createMotion`).
4. **One-shot `createMotion` / `Animated.timing`** for an arrival, a swap or a glyph (`appear`, `arriving`, `swapped`, `glyphChanged`): run once, then it stops.
5. **Presence** for a thing that comes and goes: `createPresence` + `presenceMotion`, or `popupPresence` for a popover (stays built through its exit, takes no presses while `closing`, a reopen mid-exit turns around), `enterScale` for a dialog's popup, `paletteEnter` for the palette, `leaving` for a pill with an exit.
6. **`animateLayout()`** (nsh `LayoutAnimation`): the next commit's inserted views fade in, moved ones glide, removed ones fade out. Call it before the state change that causes it.
7. **A loop** only while on screen and the person waits (`Spinner`, `Skeleton`), inside an `If`, stopped with `cleanup`.

A new motion goes through a helper in `lib/motion.ts` (or `createMotion`), is a no-op under `reducedMotion()`, gets a row in `design/motion.md` and a test in `lib/motion.test.ts`. A screen never writes a duration, easing or `transition-*` itself, and never reads nsh's `reduceMotion()` (the app's own setting must apply too).

## 3. Properties and the frame budget

- Animate `transform`, `opacity` and colours only. A height or position moves only through `animateLayout()`; a width tween is layout on every frame (the decided inspector uses a fade plus the layout animation, not a width tween: `design/motion.md`).
- Nothing scales from below 0.95 (press) or from 0 (popover 0.96, dialog 0.97, palette 0.98). No bounce anywhere.
- **No `transition-all`, no `transition-[width]`/`height`.** Name the property.
- **Never animate inside a virtual `List` cell.** Cells are recycled: animate the content of a line through `arrivals()` and `arriving()`, per key, never per cell; a thing in an `Each` list uses `appear(key)`. The sidebar's rows and fold do not animate (recycling).
- **Never move the pane mirror.** `PaneScreen` is data drawn from Rust rows as it arrives (principle 5); no wrapper that animates it.
- A first screen does not perform: `motionReady` is set after the first paint, and a restored layout builds still. Only what arrives afterwards moves.
- Frequent updates are throttled: `swapped()` plays at most once per `SWAP_QUIET_MS` (1000), `contextEnter` skips repeats within `CONTEXT_REPEAT_MS` (400).
- **At rest nothing draws.** After a change that adds motion, check it stops: a scenario of `bun scripts/perf.mjs` (Linux, `docs/PERFORMANCE.md`: the scenarios and what "at rest" means) must still show no frames when idle; a loop left mounted breaks it. Frame times in Xvfb with cairo are CPU-rendered: counts and ratios are meaningful, absolute times are not. On a Mac there is no perf script (`/proc`): say frame cost is unverified.

## 4. Curves and durations

Pick the token by role, not by the number you want: `press` 100, `hover` 120, `swap` 140, `pop` 160, `popup` 160 / `popupExit` 120, `dialog` 200 both ways (nsh fades the dialog's layer for a fixed 200 ms; it is the one exit not quicker), `toast` 200 / `toastExit` 150, `fold` and `rise` 200, `context` 120. Nothing is longer than 240 except by that dialog rule. Enters and presses use `EASE_OUT` (strong: the answer is at once); something already on screen that moves uses `EASE_MOVE`; exits use `EASE_IN`. If no token fits the role, add one to `lib/motion.ts` with its reason and a row in `design/motion.md`; do not inline a value.

## 5. nsh facts that bite

- Style transitions take `transitionProperty`, `transitionDuration` (ms) and `transitionTimingFunction` as a `cubic-bezier(a,b,c,d)` string with no spaces after commas; Tailwind-style classes work too (`transition-[opacity,transform] duration-[200ms] ease-[cubic-bezier(...)]`, as `toastLook()` builds).
- `motion-reduce:` classes, nsh's `Dialog` fade and a `createMotion` `enter` follow only the system setting; the app's own Settings > Reduce motion cannot reach them. A dialog still fades and a `CheckRow` check still pops in when only the app setting is on: a documented limit, not a bug to patch in a component.
- `Animated.timing` and `createMotion` retarget from the current value, so a reversed motion starts from where it is; a keyframe `play` restarts. Prefer a value over a keyframe for something interruptible.
- `Toast` has no look of its own: `toastLook()` supplies it, and the store keeps it built for `exitMs`.
- `ring-*` and box-shadow rings draw nothing on the host: a focus or selection change is a colour or an outline (`FOCUS_RING*`), not an animated shadow.
- Do not read the real clock in a motion test: time and timers in `lib/motion.ts` go through `motionClock` so a test replaces them (`herdr-test`).

## 6. Reduced motion ships with the animation

`reducedMotion()` is the system `reduceMotion()` or Settings > Reduce motion. Under it: drop movement and scale, keep nothing that needs a timer, snap popups with no exit wait (`createPresence` does not wait), no arrivals, no swaps, no layout animation, no press scale. Test both paths: `open("./App.tsx", { ...DESKTOP, reducedMotion: true })` (see `components/feedback.test.tsx`, `settings.test.tsx`), and a `lib/motion.test.ts` case per helper. On Linux the system signal is GTK's `gtk-enable-animations`; `gsettings set org.gnome.desktop.interface enable-animations false` turns it off (`docs/ACCESSIBILITY.md`).

## 7. How to work

**Building motion.** Go through sections 1 to 6 in order, write the code, then report in a few lines: the frequency tier and purpose (or why you built nothing), the ingredients (tool, properties, token), the `design/motion.md` row and the test added, and what needs a feel-check in the real app. Do not offer options; make the call and give the reason in one line. Motion cannot be judged from a still: say what you could not see (`herdr-screen-check` renders a still; a mid-flight frame needs `app.screenshot` after `clock.runFor` in a test, or the real window).

**Reviewing motion.** Default to flagging. One table:

| Before | After | Why |
|---|---|---|
| `transition-all duration-300` on a row | `hoverTransition()` | named property, 120 ms, strong ease-out, reduced-motion aware |
| `appear()` on a cell of a `List` | `arrivals()` + `arriving()` per key | a recycled cell replays the arrival while scrolling |
| `setTimeout(close, 200)` for an exit | `createPresence` / `popupPresence` | cancellable, takes no presses while closing, reduced-motion aware |

Cite `file:line`, then a verdict, **Block** or **Approve**. Block for: a loop at rest or left mounted, animation of a keyboard action or of anything done 100+ times a day, a raw duration or easing outside `lib/motion.ts`, ease-in on an enter, `transition-all`, a missing reduced-motion path, motion in a recycled cell, motion on the pane mirror, something that moves under the pointer and accepts a press. Prefer fixes in this order: delete it, reduce it, fix the token or curve, make it interruptible, move it to transform or opacity, make it asymmetric, polish.

**Auditing or finding opportunities.** Sweep `components/` and `lib/` for `transition`, `duration-`, `ease-`, `Animated.`, `createMotion`, `LayoutAnimation`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `Spinner`, `Skeleton`, `animate-`. Look for jarring changes (content that teleports, a section that pops, an arrival with no `animateLayout`). Gate every candidate through section 1. Cap suggestions at 5 to 7, ordered by leverage, and list the candidates you rejected with the question that killed them. "The motion here is already right" is a valid result. Respect decisions `design/motion.md` documents; its "Decided, not built yet" (the inspector's slide) binds a future change.

**Naming an effect.** Use `emil-design-vocabulary` for the term, then map it to a helper in `references/recipes.md`.

## Never ship

| Never | Instead |
|---|---|
| A loop, pulse, shimmer or idle animation | Still state; `Spinner` / `Skeleton` only while on screen and the person waits |
| Animation at rest or on agent-driven updates | One settle when it changes on screen, or nothing |
| A duration, easing or `transition-*` outside `lib/motion.ts` | The helper or a new token |
| `transition-all` or a layout property | A named property: `colors`, `transform`, `opacity` |
| Ease-in on an enter, ease-out on an exit | `EASE_OUT` in, `EASE_IN` out, `EASE_MOVE` on screen |
| Scale from 0 or under 0.95 | 0.96 to 0.98 plus opacity |
| Motion on a keyboard action | Nothing; `markKeyboard()` is the window |
| Motion in a `List` cell or on `PaneScreen` | `arrivals()` on the content; none on the mirror |
| `reduceMotion()` in a screen | `reducedMotion()` |
| A motion test against the real clock | `motionClock`, or `clock.runFor` |
| "It felt fine on my machine" | Say what was not seen in a real window |
