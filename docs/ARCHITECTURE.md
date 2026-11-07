# Architecture

How herdr-desktop works, what it runs on your machines, and what it keeps on disk. Paths are relative to the repository root. Anything marked **unverified** has not been run yet.

## 1. What runs where

```mermaid
flowchart LR
  subgraph app["herdr-desktop (one process)"]
    tsx["TSX screens (nsh, UI thread)"]
    native["herdr-desktop-native: Herdr module, PaneScreen"]
    core["herdr-core threads: one set per machine"]
    tsx -- "sync pulls: Herdr.board(), paneMeta()" --> native
    native -- "revision tick (Callback::post)" --> tsx
    native <--> core
  end
  core -- "unix socket, one request per connection" --> local[("local herdr socket")]
  core -- "system ssh, ControlMaster" --> sshd["sshd on machine B"]
  sshd --> relay["python relay"] --> sockB[("herdr socket on B")]
  sshd --> keeper["keeper (python3), one per agent session"]
```

- **herdr.** Only its public JSON API: newline-delimited JSON on its unix socket, one request per connection; `events.subscribe` is a long-lived stream. Never its private client socket. Facts come from `docs/herdr-api.schema.json`.
- **Remote machines.** The system `ssh` binary (it honours `~/.ssh/config`, the agent, ProxyJump and Tailscale SSH), one shared connection per machine (`ControlMaster`), and a small python relay sent with the command. No in-process SSH stack, no password prompts (`BatchMode=yes`). A host key that is not trusted yet is reported with the text to run `ssh <dest>` once.

## 2. Threads and data flow

The UI thread belongs to the person.

1. `herdr-core` owns one `MachineLink` per machine on std threads with blocking sockets (no async runtime): a request pool, an events thread, a reconnect loop. It publishes immutable `Arc<Snapshot>` values with a monotonically increasing `revision`.
2. The native crate coalesces core updates to at most one per 16 ms and posts a revision tick to TSX. TSX never receives data in the tick: it pulls with synchronous module calls, so a burst of events costs one commit.
3. Pane screens never go through TSX: `PaneScreen` reads `Arc<Screen>` rows from core and rebinds only rows whose hash changed.
4. Domain persistence is Rust (`<dataDir>/{machines,reviewed,settings}.json`, atomic temp + rename, mode 0600). TSX keeps UI-only state; the dock layout is the one TSX value (`Storage` key `herdr.dock.v1`).

## 3. Decisions with their reasons

| Decision | Reason |
|---|---|
| nsh 0.4.0, GTK backend | Standalone nsh apps use GTK on Linux; GPUI is the embedding backend. |
| Own `PaneScreen`, not `Terminal` | `Terminal` and the Linux tray exist only on nsh `main`, not in 0.4.0. Swap in with a clean cutover when a release ships them. |
| Pane view is a mirror | `pane.read format=ansi` has no cursor and no mouse; input is injected keys, as on mobile. herdr cannot resize a pane over the API, so columns are herdr's. |
| One shared `target/` | The data disk is nearly full (`.cargo/config.toml`). |
| `AR=/usr/bin/ar` pinned | A foreign `ar` earlier in `PATH` breaks `cc-rs`. |
| License GPL-3.0-or-later | The app links GPL-3 crates from herdr-mobile; nsh is Apache-2.0, compatible. |

## 4. Verified spikes

- **Foreign-thread wake works.** A module function that takes `cx: CallCx` and a `Callback<u32>` starts `cx.start(async { while let Ok(v) = rx.recv().await { listener.post(v) } })` over an `async_channel` receiver; a plain `std::thread` sends 1..300 at 1 kHz; draining with `try_recv` coalesces them and the TSX listener sees the last value (headless `nsh test`, nsh 0.4.0). The `set_interval` fallback is not needed. A `Callback<u32>` is `(value: number) => void` in TS: the one-object event shape applies to components, not to Rust callbacks.
- **herdr has no `pane_output_changed` event.** `events.subscribe` types use dots (`pane.updated`, `workspace.updated`, `layout.updated`, ...); `pane.agent_status_changed`, `pane.scroll_changed` and `pane.output_matched` need a `pane_id`. Live content changes arrive as global `pane_updated` events (about 25 per second across 26 panes), each carrying the pane's full info with a bumped `revision`. A watched pane is re-read when its revision changes, throttled to 20 Hz.

- **`DockArea` works headless (nsh 0.4.0).** Spike: a controlled `DockArea` renders every panel and tab, reports the whole layout with node ids after each edit, `addPanel`, `movePanel`, `splitAt`, `selectPanel` and `groupOf` act, and a press on a tab selects it; tabs are found as `role:tab`. So the workspace uses it as it is, and no tab fallback was built. Decisions that came with it: the layout is controlled (`lib/dock.ts` keeps it, so it can be saved and a panel for a vanished pane can be shown as `Agent gone`); only the center is used (no docks); the board is `closable: false`; the area has no "focused group", so `lib/dock.ts` tracks the panel last opened, selected or moved (`focused`) and the tab keys, close and split act on its group; a tab that is the only one in its group cannot split away, which the area would silently refuse, so the app says so.

## 5. Open items

- **unverified:** `Command` inside the kit `Modal`, and `DockArea` in a real GTK window (tab drags, focus rings, compact width): only the headless runner has been used. Fallbacks: kit `Combobox` panel for the palette, `ResizablePanelGroup` + kit `Tabs` for the workspace.
