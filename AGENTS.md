# herdr-desktop

The desktop counterpart of `herdr-mobile`: a native Linux-first app that shows every coding agent on every machine, says the moment one needs you, lets you answer safely, and lets you look away. Built with nsh (Native Shell: Rust + TSX, native GTK 4 widgets, not Electron). `README.md` has the product; read `DESIGN.md` before touching any UI. This file is how to work here; `CLAUDE.md` and `GEMINI.md` are links to it.

## Who it is for

A **supervisor, not a pair-programmer.** Someone whose agents run under the `herdr` terminal multiplexer, on this computer and others, while they do other things. Every time they look at the window they ask, in order:

1. **Does anything need me?**
2. **Is everything alive and on track?**
3. **What did it do?**
4. **Steer it:** correct, redirect, stop, start.
5. **Can I trust it?** The agent, and what this app shows.

A screen, row, word or animation that answers none of these is noise. Desktop means keyboard first, many agents visible at once, and no touch or battery limits: it does not mean more chrome.

## Principles

1. **Attention is the product, and it is calm.** What needs the person is the loudest thing on a screen and the only loud thing, but it is said ONCE per agent per view and never everywhere at once: a screen full of attention marks is stress, not information. Motion is allowed and wanted when it explains a change (something appears, folds, finishes), short, eased out, and never decorative; reduced motion is honoured. An app at rest draws no frames.
2. **Safe by construction.** Nothing is ever approved silently, by default or on a timeout. The person sees what they approve (the command itself). A risky answer is two-step (press, then press again within 4 s), never a timed hold: holds are not accessible.
3. **Honest.** Stale is shown as stale, offline says offline, a failure says what happened and what to do. Never fake liveness.
4. **Accessible first.** Every control has a name, every state is a role or state (not colour), focus is always visible, everything works from the keyboard, and `fontScale()` 2.0 and reduced motion survive. `docs/ACCESSIBILITY.md` is the checklist; `make a11y` is the gate.
5. **The UI thread belongs to the person.** Sockets, ssh, parsing and ACP run on `herdr-core` threads. TSX never receives data in an event: it is told "revision N" and pulls with synchronous module calls. Pane screens never go through TSX (`PaneScreen` reads Rust rows).
6. **One of each.** One answer dock, one toast, one palette, one guard. Two patterns for one job means migrating to one.
7. **One connection per machine, shared.** A fault in one machine never touches another. Remote machines use the system `ssh` (ControlMaster) and a small python relay: no in-process SSH stack.
8. **Fail loud and classify.** A wire error says whether it is fatal (stop retrying, show `Attention`) or retryable.
9. **Protocol facts come from `docs/herdr-api.schema.json`**, refreshed with `make schema`, not from memory. herdr's public JSON API (its unix socket) only; never its private client socket.
10. **Clean cutover.** Migrate every caller and delete what a change made obsolete; no shims, aliases or deprecated paths.

## Rules that do real damage when forgotten

- **Never kill a process you did not start.** This machine runs the owner's other work (training runs, agents, herdr itself). No `pkill -f`, `killall` or name/pattern kills. Keep the PID of what you spawn and kill that PID. The app owns only its own `ssh` and keeper children. Subagents get this rule in their task text.
- **Never call a mutating herdr method against the user's live herdr with empty params** (an empty `tab.create` creates a tab). Tests use the fake herdr server (`native/core/src/testing`). Live smoke uses read-only methods (`ping`, `session.snapshot`, `pane.read`, `agent.list`) or a scratch workspace labelled `herdr-desktop-scratch`, `focus: false`, closed afterwards.
- **Pane screens are private user data** (code, secrets). Fixtures are synthetic only, produced from `herdr-mobile/tool/demo-agent.py` in a scratch pane. Never commit, log or screenshot a real pane.
- **Anything typed into a remote shell is validated or single-quoted** (`shq()` in `native/core/src/ssh`), with an injection test. A destination is validated and always follows `--`.
- **Nothing is approved silently.** No timer, default or notification sends an answer; the answer path re-reads the pane and refuses when the question changed.
- **Never put a secret on a command line, in a log or in a fixture.** ssh identities stay with ssh.
- **Versions.** The line is 0.1.x: patch bumps only, unless the owner says otherwise. `nsh.json` `version` and `native/*/Cargo.toml` move together.
- **Do not upgrade nsh** (0.4.0, `nsh -V`) unless asked. Its online docs track `main`, not the installed runtime: for what 0.4.0 does, clone tag `v0.4.0` into `.scratch/nsh-0.4.0` and read `crates/`. `Terminal` and the Linux tray exist only on `main`; when a release ships them, swap in with a clean cutover.

## Commands

```sh
make                       # verify: nsh check, nsh test, core (fmt+clippy+test), docs, a11y
nsh check                  # types: must print nothing
nsh test [path|--filter n] # headless; --trace shows ops; --target linux = real GTK window (xvfb-run -a env GSK_RENDERER=cairo ...)
make core                  # cargo fmt/clippy/test of native/core and native/app
make docs                  # DESIGN.md < 100 lines, design/*.md < 150, every backticked name exists
make a11y                  # AT-SPI tree of every screen, no unnamed control
make run | package        # dev window | .tar.gz under .scratch/dist
make schema                # herdr api schema --json > docs/herdr-api.schema.json
make theme                 # bun scripts/gen-theme.mjs, only after the default theme's spec changes
make perf | cpu            # scenarios in a real window (Xvfb + cairo without a display), tables in docs/PERFORMANCE.md
make perf-check            # the same, three runs each, fails when a median breaks .perf/budgets.json
```

Run `nsh` and `cargo` with the repo root as the working directory, or rustup does not see the pin (`rust-toolchain.toml`: 1.99.1). `.cargo/config.toml` turns debug info off and sets one shared `target/`: never create a second target directory, the data disk is nearly full. It also pins `AR=/usr/bin/ar` because a foreign `ar` earlier in `PATH` on the owner's machine breaks `cc-rs`. Build needs `libgtk-4-dev`, `clang`, `pkg-config` (`docs/DEVELOPMENT.md`).

## Map

```
App.tsx, App.test.tsx   shell, keymap, routes; the end-to-end tests
components/*.tsx        one file per screen or part, kebab-case (`pane-tab.tsx`, `answer-dock.tsx`)
components/kit/         the UI kit (from ship-desk, on nsh 0.4.0). Import from "./kit" only
lib/                    TSX state and rules, no screens (the kit's feedback helpers are allowed): theme/, settings, shortcuts, motion, perf, save, text
native/core/            crate herdr-core: pure Rust, no nsh. wire, link, ssh, store, board, prompt, screen, testing
native/app/             crate herdr-desktop-native: #[native_module("herdr-desktop/native")]; Herdr module, PaneScreen
design/*.md, DESIGN.md  the design system
docs/                   ARCHITECTURE, ACCESSIBILITY, PERFORMANCE, PARITY, DEVELOPMENT, herdr-api.schema.json
scripts/                gen-theme, perf, cpu, gen-big-fixture, check-docs, atspi_audit, sync-schema
.perf/                  scenarios and budgets.json for scripts/perf.mjs and cpu.mjs (hidden: nsh test skips it)
perf-app.tsx, perf-chat.tsx  entries of those scenarios (the app plus a driver for the scripted herdr; in the root because an app finds its fonts only under its entry directory)
.scratch/               gitignored scratch: screenshots, builds, nsh checkout. Never /tmp
```

`components/*-probe, *.fixture, *-lab .tsx` are test entries for the end-to-end tests (`open()` needs an entry under the app directory); they are not the app.

## Read first

| You are changing | Read |
|---|---|
| any UI | `DESIGN.md` (the quiet look, the rules, the closed lists) |
| colour, theme, a token, terminal colours | `design/colors.md`, `design/themes.md` |
| text, fonts, copy | `design/typography.md` |
| spacing, type, sizes, layout numbers | `design/foundations.md`, `lib/layout.ts` |
| how attention, state and counts are shown (once per agent per view) | `design/attention.md` |
| a component or the sidebar | `design/components.md` |
| a field, validation, a form | `design/forms.md`, `design/inputs.md` |
| a menu, select, combobox | `design/menus.md`, `design/combobox.md` |
| a tooltip, popover, any popup | `design/overlays.md` |
| checkbox, radio, switch, tabs, accordion, progress | `design/controls.md` |
| a dialog, a toast, undo | `design/dialogs.md` |
| a table or long list | `design/data.md` |
| feedback, undo, settings, window size | `design/patterns.md` |
| anything that moves | `design/motion.md` |
| accessibility, screen readers, keyboard | `docs/ACCESSIBILITY.md` |
| how nsh 0.4.0 behaves on this host (quirks that bit us) | `docs/DEVELOPMENT.md`, "nsh host quirks" |
| threads, links, data flow, herdr protocol facts | `docs/ARCHITECTURE.md` |

## Code rules

- **Project imports are absolute** through `package.json` `imports`: `#lib/<file>`, `#components/<file>`, `#kit` (never `../` or `./` for project code). Exceptions: siblings inside `components/kit/`, assets (fonts, SVG, PNG) and the `.ts` test seams in `components/`. `node scripts/absolute-imports.mjs` converts, `--check` is part of `make check`. Why not `@/`: nsh reads `resolve.alias` from the nsh.json next to the entry, which labs under `components/` do not have; `imports` is resolved by package, so it works everywhere (bundle, `nsh check`, `nsh test`).
- **File names are kebab-case** for every `.ts`/`.tsx` file (`dev-panel.tsx`, `pane-tab.tsx`, `answer-dock.tsx`); the exported component keeps its PascalCase name (`DevPanel`). Tests sit beside what they test (`palette.test.tsx`), test entries end in `-lab`, `-probe` or `.fixture`. Rust files are `snake_case.rs` (the language's rule).
- UI is built from the kit. A screen never pastes a kit component's class string. Colour is a semantic token class, never hex or `rgb()`: themes switch at runtime. Terminal colours are the one exception and come from `term-*` tokens.
- Global shortcuts live in `lib/shortcuts.ts` once, always with `mod` (Ctrl on Linux and Windows), never `alt` (AltGr is Ctrl+Alt; Telex and VNI type with plain letters). Do not bind `mod+q` or `F11` (nsh reserves them). `lib/shortcuts.test.ts` enforces it and `App.test.tsx` presses every global shortcut as macOS, Windows and Linux.
- `lib/` imports no screens. It may import `components/kit` for feedback (`notify`, `confirmDestructive`, `undoLast`) and the kit imports only `lib/motion`, `lib/perf`, `lib/shortcuts`, `lib/settings`, `lib/text`: keep that one-way. Domain persistence is Rust; TSX holds UI-only state.
- Comments say why, never what. Docs change in the same change as code: `make docs` fails otherwise.
- No tiny one-expression wrappers unless used three or more times. Never `ReturnType<typeof fn>`. Top-level `import type`.
- Rust: `cargo clippy -- -D warnings`, no `unwrap` on I/O, no allocation per row on a hot path that a reused buffer avoids.

## Tests

- Test what a person would notice: behaviour, boundaries, transitions, errors, precedence. Never wiring, copies, source text, incidental defaults or wording; delete such a test instead of re-pinning it.
- A test never depends on the clock or the CPU: poll for the condition, await the event, or inject a clock.
- End-to-end tests use `seeded(name)` (opens against the fake herdr), `DESKTOP` (1280x800) and select by `label:<accessibility label>`. The fake server is the only herdr a test talks to.
- A bug has a test that failed before the fix.

## Definition of done

1. `make` is green.
2. A UI change was looked at: screenshot (cairo under Xvfb) at 1280, 960 and 760 px, light and dark, two themes; `make a11y` shows no unnamed control.
3. Docs updated in the same change; `theme.json` regenerated if the default theme changed.
4. A performance-sensitive change reports the scenario deltas of `docs/PERFORMANCE.md`.
5. Nothing stray outside `.scratch/`; real pane data never reaches git, logs or screenshots.
6. Report what was verified and what was not (mark unverified).

## Commits

Semantic (Conventional Commits): `type(scope): subject`, imperative, lower case, at most 72 characters, no full stop.

- **Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. `!` after the scope or a `BREAKING CHANGE:` line when a stored format or wire contract changes.
- **Scopes:** `core wire link ssh board prompt screen pane session observed kit theme a11y notify files perf`. Leave it out when a change spans many.
- **Body** says why and what was measured or left unverified. One logical change per commit.
- The remote is `origin` = `https://github.com/tuan3w/herdr-desktop.git`. Do not rewrite or force-push published history.
- Release commits are `chore(release): x.y.z, <headline>`; the tag is what `release.yml` reads.

## Writing things down

- **Screenshots are not committed**, except the few the README shows (`docs/screenshots/`, three images): a gallery goes out of date and costs git space for ever. `make shots` writes to the ignored `.scratch/shots/`.
- Facts go next to what they describe: a hard-won fact about a subsystem goes in its doc under `docs/`. Give the reason next to the rule, with the failure that taught it.
- `DESIGN.md` is the design system, not a changelog.
- Mark what was not measured or run (unverified), so a claim never outlives its evidence.
