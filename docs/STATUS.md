# Status: what is built, what is open

The working state of the app. It changes with every slice, so it lives here and not in `AGENTS.md`, which is the long-term brain. Update this file in the change that moves something. Claims are marked **unverified** until they have been looked at in a render or measured.

## Built (tests pass; mostly not seen on Linux, at 960/760 px or in dark)

- The kit (`components/kit/`), type scale and row tiers (`lib/layout.ts`, `nsh.json`).
- Sidebar grouped by project, one-line rows, project header as one quiet line, the rail while the Board is open, a footer for connection problems.
- The Board as a project-grouped table with filter chips, and bulk answering of terminal prompts (two presses, every command shown, per-pane re-read).
- The one answer dock in the composer's place; the ranked chat turn (calls as one muted line, effects and failures always visible).
- Settings dialog (large, centered; Machines inline in its page).
- Quiet code toolbar, tooltip clamping, menu letters, toast at the top right.
- Changes review says what is reviewed (project, branch, machine, agent, totals, progress in one header) and its rows are 32 pt with a status letter, the whole name and green/red counts; rendered on macOS only, Linux and the agent-in-header fit unverified.

- Worktrees: the branch of each checkout in the sidebar, `Checkout` and `New worktree…` in New session, and `New worktree…` in the project menu; tested against the scripted herdr only, never rendered (Linux or macOS), no live herdr with worktrees, no remote machine, no untrusted-repository flow against herdr.

## Open

- **Inspector**: Overview, Changes, Files and Terminal as tabs; the context meter's home; Files redesign (`design/files.md`).
- **Dialog cleanup**: about ten dialogs that should be pages, popovers or toasts (see `design/dialogs.md`).
- **Engine**: stable last-activity order (`order_rows` in Rust) and a field for the `quiet 41m` word.
- **Chat**: a scroll-to-end button; the opened diff and output still draw the native code view's grey card (needs a native option); the full diff belongs in the inspector.
- **Renders never taken**: hover states, dark mode for most screens, 960 and 760 px, `fontScale()` 2.0, Linux/GTK, `make a11y`, performance budgets (Linux only).
- **Leftover 36 pt controls** beside 32 pt fields: `components/files.tsx`, `components/folder-picker.tsx`, `components/kit/collapsible.tsx`, `components/board.tsx`, `components/changes-notes.tsx`.
- **Worktrees**: `Remove worktree…` (`worktree.remove`, never the main checkout, never while an agent works in it) and an explicit `Trust this repository` are not built; a created worktree also opens as a shell workspace in herdr.
- **Test hardening**: the session tests that use a real keeper subprocess; any test that fails only in the full run is a flake to fix with `herdr-test`.
- **Earlier messages**: Rust (`load_earlier`, `observed.earlier`) is done and tested; mounting `EarlierRow` and `createAutoLoad` in the transcript is open (`design/chat.md`). Not run against real logs or a remote machine.
