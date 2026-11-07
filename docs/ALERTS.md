# Alerts

How Herdr Desktop tells you that an agent needs you while you are looking at something else. Adapted from herdr-mobile's `docs/ALERTS.md`: the rules are the same, the delivery is the desktop's notification service instead of Android's, and there is no foreground service because a desktop does not freeze a background app. Paths are relative to the repository root. Anything marked **unverified** has not been seen on a real desktop.

## 1. Desktop notifications (in the app, off by default)

Settings > Notifications > **Notify me when an agent needs me**. Everything happens on this computer: no relay, no account, nothing leaves it.

- A notification appears when an agent **becomes** blocked on a question. **Also when an agent finishes** is a second, separate switch (it needs the first); it shows a quieter notification for an agent that is done and not yet reviewed.
- It is posted only while the window is **away** (`Herdr.setBackground`, which `App.tsx` drives from `lifecycle()`). **Coming back withdraws every notification of ours**, and one is withdrawn as soon as its agent is seen to stop needing you (you answered somewhere else, the pane closed). A link blip or an offline machine does **not** withdraw it: you were told, and it stays until you come back or the agent leaves the state.
- Whatever was already blocked when the window went away (last known state, also on machines that were unreachable) is not announced. Switching the setting on while away counts the current state as seen too. Whatever finished before "Also when an agent finishes" was switched on is not announced either.
- At most three notifications of their own per burst (announcements within 5 s of the first); the rest become one summary, `N agents need you` (and a separate `N agents finished`), where N counts every agent of that kind the burst announced or held back. The summary opens the board. An agent that flaps is announced at most once a minute; a blocked agent that comes back inside the minute is held and announced when the minute is up if it is still blocked.
- An agent is announced once per **episode** (machine, pane, `state_change_seq`). A new question from an agent you answered from a notification is news at once.
- A notification names the agent and says what it asks: its text is the question, the command or path being approved (up to six rows, the same text the answer dock shows) and `claude on This computer`. A question that has not been read yet is waited for up to 3 s; after that the agent is announced without one. A server that renders markup (`body-markup`) gets the text escaped, so a command with `<` or `&` reads as typed.
- A blocked agent's notification never expires on its own. A finished agent's does as the desktop decides.
- **Click.** The body of a notification (freedesktop action `default`) brings the window forward (`Window.orderFront()`; the window manager may refuse) and opens that agent's tab; a summary opens the board. The app side is `Herdr.onNotificationOpen(listener)` (in `native/app/src/api.rs`), which `App.tsx` listens to.
- **Answer from the notification.** For a blocked agent whose question the app understands, the notification carries up to two buttons, only for options that are neither risky nor standing grants (`answerable_from_notification`, `native/core/src/prompt`), and only when the command is at most 640 characters (a longer one is not shown whole, so it is not approved from here). A press goes through the same path as the answer dock (`Fleet::answer`, `native/app/src/engine/answer.rs`): the pane is re-read and the keys are sent only if the agent is still blocked on the same question (the digest of the question, the command and the words of the options). The press is spent before anything is sent, so it cannot send twice. If the question changed, the agent is not blocked any more or the machine cannot be reached, nothing is sent and the notification is replaced by `Answer not sent` with the reason (its click still opens the agent). No timer and no default ever sends an answer.

What this does **not** do, plainly:

- Notifications are not withdrawn when the app quits, and one left from a previous run is not cleared when you come back: the freedesktop service has no call to list them, and the engine lives in the process with nothing that runs at exit. A leftover is dead: clicking it does nothing. (The engine does withdraw its own when it is stopped, which only a restart of the engine inside a running app does.)
- No tray icon: nsh 0.4.0 has none (`docs/PARITY.md`).
- Whether buttons show, and how, is the desktop's choice. GNOME shows them when a notification is expanded; some services show none. When the service does not advertise `actions`, the app sends no buttons and a click is the only action. **Unverified** on a real desktop; verified against the stand-in service described below.
- **On macOS** delivery is `osascript`'s `display notification` (`native/app/src/notify/applescript.rs`): a title and a body, nothing more. No answer buttons, so a notification there is news and you answer in the app; a click does not come back to the app (macOS opens Script Editor, which owns the notification) and does not open the agent; a notification is not withdrawn when its agent stops needing you; and macOS lists it under Script Editor in System Settings > Notifications, where you allow it once. The text goes to `osascript` as arguments after `--`, never inside the script, so a command with quotes cannot become AppleScript. **Unverified** on a Mac: no Mac was available; the argument rules are unit-tested.

### The pieces

| Piece | Where | Does |
|---|---|---|
| Rules | `native/app/src/notify/policy.rs` | Pure state machine: a frame of what the board shows and an `Instant` in, notifications to show and withdraw out. No I/O, no clock. |
| Thread | `native/app/src/notify/mod.rs` | One thread; gets "something changed" (`Input::Tick`), "window away" (`Input::Away`), presses and dismissals; asks the engine for the switches and the agents; runs answers off the thread. |
| Engine side | `native/app/src/engine/alerts.rs` | The settings keys, the list of blocked and finished agents with their questions (starting the read of a question that has not been read), the answer path. |
| Delivery | `native/app/src/notify/freedesktop.rs` (not macOS), `native/app/src/notify/applescript.rs` (macOS) | Linux: `org.freedesktop.Notifications` over the session bus with `zbus`'s blocking API: one connection, one listener thread for `ActionInvoked` and `NotificationClosed`. Connects on first use, so notifications off never touch the bus. macOS: see above. |
| Test seam | `native/app/src/notify/recording.rs` | An engine started with a fixture records its notifications instead of showing them, so no test posts on the owner's desktop. |

`notify-rust` 4 builds on the same `zbus` but its handle waits for a response by consuming itself (one notification can be waited on or withdrawn, not both) and every wait is a thread and a bus connection of its own, so the app talks to the service directly.

### Settings

| Key (settings file) | Meaning | Default |
|---|---|---|
| `notify.needsYou` | `Notify me when an agent needs me` | off |
| `notify.alsoDone` | `Also when an agent finishes` (read only while `notify.needsYou` is on) | off |

`Herdr.notificationSupport()` says whether a notification service answered on the session bus, and whether it shows buttons; Settings asks when it opens with notifications on and when they are switched on, and says `No notification service` rather than looking fine when there is none.

## 2. Optional: a host plugin that posts to ntfy

For an alert on a phone while this computer is off, herdr-mobile's `herdr-ntfy` host plugin posts to an ntfy topic when an agent becomes blocked. It runs inside herdr on the machine, is independent of this app and works unchanged; see herdr-mobile's `docs/ALERTS.md` for its install and its topic hygiene. herdr's own `ui.toast delivery = "system"` is independent too and untouched.

## Testing

```sh
cargo test --manifest-path native/app/Cargo.toml --lib notify          # the rules, with a moving Instant
cargo test --manifest-path native/app/Cargo.toml --test notify         # through the engine, recorded
cargo test --manifest-path native/app/Cargo.toml --test notify_dbus    # real D-Bus, stand-in service
nsh test components/notifications.test.tsx                             # the whole app
```

`notify_dbus` starts a private session bus (`dbus-daemon`) and `native/app/tests/support/notification_service.py` (python3 with `gi`) on it, runs the real notifier and `DesktopSink` against a scripted source on a manual clock, and asserts what the service was called with (the question and command in the text, at most two buttons, a burst of five blocked panes as three notifications and one summary, an already blocked agent not announced, withdrawal, a spent button, a refusal replacing the question, a click handed to its listener). It kills only the two processes it started, by handle.
