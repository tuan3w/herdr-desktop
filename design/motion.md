# Motion

Herdr Desktop is used all day, mostly by keyboard. Motion confirms a pointer action and introduces the occasional modal or toast. It never sits between the user and the next screen.

All values live in `lib/motion.ts`. Do not write a duration, easing or `transition*` style anywhere else.

## What animates

| Thing | Motion | Helper | Why |
|---|---|---|---|
| `Btn` (default size) pressed | scale to 0.96 on press, back on release, 120ms `EASE_OUT`, from the current value so a mid-press release glides back | `pressFeedback()` | a pointer click should feel received; interruptible |
| `Btn` press and hover color | color eases, 120ms | `pressTransition()` | no snap on hover |
| Row, tab, nav item, `IconButton`, `SelectField` trigger, `CheckRow`, inputs, the sidebar's drag handle line | hover and selected fill (the handle: its color) eases, 150ms | `hoverTransition()` | the fill should not snap as the pointer crosses a list |
| Check mark | pops in from scale 0.4, opacity 0, 160ms `EASE_OUT`, each time it mounts | `CheckRow` (`createMotion`) | the one moment of reward in a checklist |
| `Switch` thumb | slides 160ms, `transform` only | `moveTransition()` | the thumb should travel, not teleport |
| `Spinner` | the arc turns, 800ms a turn, linear, until unmounted | `createMotion` in `loading.tsx` | work with unknown duration: a loop is the point |
| `Skeleton` | opacity 1 to 0.5 and back, 1.4s a cycle | `createMotion` in `loading.tsx` | "something is coming", without a spinner in every block |
| Dialog | popup scales 0.97 to 1, 220ms `EASE_OUT`; layer and scrim fade (`animation="fade"`, nsh-owned) | `enterScale()` in `Modal` | occasional, user-invoked: the one place an entrance helps orient |
| Toasts | enter, stack, swipe and exit are the `ToastStack` springs (nsh-owned) | `ToastHost` | feedback that must be noticed without blocking |

## What never animates

| Thing | Why |
|---|---|
| Screen and tab switches (`⌘1`, `⌘⇧1` to `⌘⇧9`, the sidebar) and tab content | keyboard-driven and repeated all day; a transition is a delay |
| Anything a keyboard shortcut does, except opening the dialog | the user already knows what will happen |
| Rows removed or restored (`Reviewed`, dismiss, `Undo`) | the toast says what happened; reflow animation hides which row moved |
| `ActionMenu` and `RowMenu` popups, tooltips | the menus appear and move the highlight at once (keyboard-driven, repeated all day); tooltips are nsh's and have no animation props |
| Progress bar width | `Progress` sets indicator width by value and has no motion; animating `width` forces layout |
| Keyboard focus ring | focus must appear instantly |
| `small` buttons (28pt rows: `Reviewed`, `Undo`) | dense and high-frequency; they only ease color |
| Row actions appearing on hover (`group-hover:opacity-100`) | instant: the pointer is already on the row, and a fade would make the action feel slow to reach |
| Switching theme or appearance | the app adds no animation: the user is looking at the setting they just changed, and a whole-window fade is a full repaint |

The dialog opens from `⌘N` too and gets the same entrance. It is a rare modal, not list navigation.

## Values

| Name | Value | Used for |
|---|---|---|
| `DURATION.press` | 120ms | `Btn` scale and color |
| `DURATION.hover` | 150ms | hover and selected fill |
| `DURATION.pop` | 160ms | check mark, switch thumb |
| `DURATION.enter` | 220ms | dialog popup |
| `DURATION.exit` | 160ms | reserved: no app-owned exit exists; the dialog's fade-out and the toasts' exit are nsh's |
| `EASE_OUT` | `[0.32, 0.72, 0, 1]` | anything entering or pressing |
| `PRESS_SCALE` | 0.96 | pressed `Btn`; below 0.95 looks exaggerated |
| `ENTER_SCALE` | 0.97 | dialog popup start; never from 0 |

Exits are about 25% faster than enters: leaving should feel quieter than arriving.

## Rules

1. Animate only `transform`, `opacity` and colors. Never `width`, `height`, `top`, `left`, `margin` or `padding`.
2. `transitionProperty` is always named (`"colors"`). Never `"all"`: it also eases layout properties you did not mean to touch.
3. Every new motion goes through a helper in `lib/motion.ts`, or through `createMotion`, which lands on the end state without moving under reduced motion. Helpers return `undefined` or do nothing under `reduceMotion()`. A screen never reads `reduceMotion()` itself.
4. Drive a scale or fade with `createMotion` (`style={motion.style}`) and `Animated.timing(motion.scale, ...)`. Do not use a `transform` in `Button`'s `activeStyle`: the host rendered the new fill and ignored the transform (tried at 0.96 and 0.7).
5. Entrances start from at least 0.95 scale (check mark is the exception: a 12pt glyph) and never from 0 for a surface.
6. Use `EASE_OUT` for entrances and presses. Do not use `ease-in`: it starts slow, so a 200ms entrance feels like 300ms.
7. Exits are faster than entrances. Under 300ms for anything the user triggered.
8. A loop (`Spinner`, `Skeleton`) is created only while it is on screen: mount it inside an `If`, never as an always-built element, and stop it with `cleanup`. A loop that outlives its view keeps the app animating forever. `Btn` mounts its `Spinner` only while `loading`.

```tsx
// Correct (components/kit/button.tsx): the press scale is driven by one helper
const press = props.small || props.still ? undefined : pressFeedback();
<Button onPressDown={press?.down} onPressUp={press?.up} style={[pressTransition(), press?.style]}>

// Incorrect: "all", hand-written duration, ignores reduced motion, transform in activeStyle
<Button style={{ transitionProperty: "all", transitionDuration: 300 }} activeStyle={{ transform: [{ scale: 0.9 }] }}>
```

## What was verified

- A press in `--trace` starts one `Timing` to 0.96 over 120ms with `EASE_OUT`, and on release one to 1.0; with `reducedMotion: true` neither starts.
- A `createMotion` transform on a `Button` was seen mid-flight in a screenshot (scale 1 to 0.5 over 4s). Hover and color easing are verified only as `Transition { duration }` settings in the trace: a screenshot cannot catch them mid-flight.
- The dialog scale starts in the trace right after the popup mounts (`Timing { to: 0.97, duration_ms: 0 }`, then `to: 1.0, duration_ms: 220`).
- `Spinner` starts one looping `Timing` of 0 to 360 over 800ms, linear; `Skeleton` a looping opacity `Timing` (700ms each way, ease in out); with `reducedMotion: true` neither starts anything (trace, no composite animation). The switch thumb easing is verified only as a configured `Transition`, like hover: its motion mid-flight was not captured.

## Adding motion

1. Is it pointer-triggered and rare enough to be noticed? If it is keyboard-driven or repeated, stop.
2. Add the value and helper to `lib/motion.ts`, a no-op under `reduceMotion()`.
3. Add a row to the tables above.
4. Test the reduced-motion path: `open("./App.tsx", { ...DESKTOP, reducedMotion: true })`.
5. Look at it: `nsh test` plus `app.screenshot(path)`; `--trace` shows the transition and animation ops headless.
