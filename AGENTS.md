# herdr-desktop

The desktop counterpart of `herdr-mobile`: a native app (Linux first, macOS built and used daily) that shows every coding agent on every machine, says the moment one needs you, lets you answer safely, and lets you look away. Built with nsh (Native Shell: Rust + TSX, native GTK 4 / AppKit widgets, not Electron). `README.md` is the product; `DESIGN.md` is the design system and is read before touching any UI. This file is how to work here; `CLAUDE.md` and `GEMINI.md` are links to it.

**This file is the brain: it stays stable.** It holds what is true for as long as the project is. A change to it needs the owner's say; an agent that thinks it is wrong proposes the edit in its report and does not make it. What changes often lives elsewhere: the state of the build in `docs/STATUS.md`, design decisions and taste in `DESIGN.md` and `design/*.md`, how-to in `.agents/skills/`, hard-won facts about a subsystem in `docs/`.

## Who it is for

A **supervisor, not a pair-programmer.** Someone whose agents run under the `herdr` terminal multiplexer, on this computer and others, while they do other things. Every time they look at the window they ask, in order:

1. **Does anything need me?**
2. **Is everything alive and on track?**
3. **What did it do?**
4. **Steer it:** correct, redirect, stop, start.
5. **Can I trust it?** The agent, and what this app shows.

A screen, row, word or animation that answers none of these is noise. Before adding anything, say which question it answers; if you cannot, do not add it.

**Desktop is not a wide phone.** A window is 1280 pt or more, the person has a pointer and a keyboard and keeps it open all day. The bar is *density* (a dozen agents visible and still room to read one), *regions* (each part of the window has one job) and *keyboard first*. "Calm" means said once and quiet, not empty: unused width and oversized type are defects, not restraint. The reference for calm is the Claude desktop app: look at its screenshot next to ours before calling a screen done.

### Regions of the window

| Region | Job | Never |
|---|---|---|
| Sidebar | The one list of every agent, grouped by project, state on the row; navigation; new | Hold what the main region holds, or list an agent a second time |
| Main | The one thing being worked on: an agent's conversation or terminal, the overview, settings | Be a second list of agents |
| Inspector (right, collapsible, remembers its state) | What you consult, not read: where it runs, branch, context used, changes, files, subagents | Hold the conversation |
| Status | Connection truth per machine, exceptions only | Repeat counts the sidebar shows |

An agent appears **once per view**. The conversation keeps a readable measure; extra width goes to the inspector or a split, never to margins. A button that opens a dialog for facts about the open agent is a missing inspector.

### Standing owner decisions (the specifics are in `design/*.md`, which win over older text)

- The sidebar is grouped by project only; attention is a mark on the row, said once, never a second list.
- Answering happens in the agent's own conversation, in the one answer dock; answering many at once is the overview's filtered view. Jumping to the next waiting agent never answers and never advances by itself.
- A chat turn is ranked by consequence, not time: the pending question, the final answer, failures and effects outside the working tree are always visible; everything else folds to one muted line.
- Settings and anything the person looks at for minutes open in the main region, never in a modal over the sidebar, so a question waiting for them stays visible.
- Looks follow `design/taste.md`.

## Principles

1. **Attention is the product, and it is calm.** What needs the person is the loudest thing on a screen and the only loud thing, said once per agent per view. Motion explains a change, is short and eased out, never decorative; reduced motion is honoured; an app at rest draws no frames.
2. **Safe by construction.** Nothing is ever approved silently, by default or on a timeout. The person sees what they approve (the command itself). A risky answer is two-step (press, then press again within 4 s), never a timed hold. Digits answer only while an answer has focus.
3. **Honest.** Stale is shown as stale, offline says offline, a failure says what happened and what to do. Never fake liveness.
4. **Accessible first.** Every control has a name, every state is a role or state (not colour), focus is always visible, everything works from the keyboard, large text and reduced motion survive. `docs/ACCESSIBILITY.md` is the checklist.
5. **The UI thread belongs to the person.** Sockets, ssh, parsing and ACP run on `herdr-core` threads. TSX is told "revision N" and pulls with synchronous module calls. Pane screens never go through TSX.
6. **One of each.** One answer dock, one toast, one palette, one tooltip, one guard. Two patterns for one job means migrating to one.
7. **One connection per machine, shared.** A fault in one machine never touches another. Remote machines use the system `ssh` (ControlMaster) and a small python relay.
8. **Fail loud and classify.** A wire error says whether it is fatal or retryable.
9. **Protocol facts come from `docs/herdr-api.schema.json`** (`make schema`), not memory. herdr's public JSON API only; never its private client socket.
10. **Clean cutover.** Migrate every caller and delete what a change made obsolete; no shims, aliases or deprecated paths.

## Rules that do real damage when forgotten

- **Never run `nsh test` bare: use `make test`, or `HERDR_DESKTOP_TEST=1 nsh test <file>`.** Without it the test seam is closed and the app under test connects to the owner's REAL herdr and machines, reads their real projects and risks a press on a real pane. It happened once (2026-11-08). The same goes for labs, shots and scripts: use the Makefile target or the script that sets it.
- **Never kill a process you did not start.** This machine runs the owner's other work (training runs, agents, herdr itself). No `pkill -f`, `killall` or name/pattern kills; keep the PID of what you spawn and kill that PID.
- **Never call a mutating herdr method against the live herdr with empty params** (an empty `tab.create` creates a tab). Tests use the fake herdr server. Live smoke uses read-only methods (`ping`, `session.snapshot`, `pane.read`, `agent.list`) or a scratch workspace named `herdr-desktop-scratch`, unfocused, closed afterwards.
- **Pane screens are private user data.** Fixtures are synthetic only. Never commit, log or screenshot a real pane. Capture only the app's own window, never the screen.
- **Anything typed into a remote shell is validated or single-quoted** (`shq()` in `native/core/src/ssh`), with an injection test. A destination is validated and follows `--`.
- **Nothing is approved silently.** No timer, default or notification sends an answer; the answer path re-reads the pane and refuses when the question changed.
- **Never put a secret on a command line, in a log or in a fixture.** ssh identities stay with ssh.
- **macOS releases are signed with the project's self-signed identity** (`scripts/sign-macos.sh`). Never commit the key or print its password; never replace the identity without `--force` and a changelog note.
- **Versions.** The line is 0.1.x: patch bumps only. `nsh.json` `version` and `native/*/Cargo.toml` move together.
- **nsh is pinned** (`nsh -V`; `docs/DEVELOPMENT.md` says which and why). Do not upgrade unless asked. Its online docs track `main`, not the installed runtime: read the tag of the pinned version for what it does.
- **Never commit or push without being asked; never rewrite published history.** No `git stash`, `checkout` or `reset --hard` to "clean up": other work is in the tree.

## Working with sub-agents

The lead (the session that talks to the owner) plans, briefs, integrates and commits. A brief is the only context an agent has, so it carries: the goal and the owner's words, the files to read first, **the files the agent may edit** (disjoint between agents running at once), the hard rules above (`HERDR_DESKTOP_TEST=1`, no kills, no commit, no stash, scratch under `.scratch/`, this file is the lead's), the skills to load, the checks to run and the report format (exact numbers, what is unverified).

- Do not run a full suite while an agent is editing: the failures are not evidence. Re-run a failing file alone before believing it; a failure that appears only under load is a flake to fix (`herdr-test`), not to ignore.
- An agent's "done" is a claim: read the diff or the render before repeating it, and check that every item of a long brief was done; agents stop early and say so only in the report.
- Report to the owner what was verified and what was not. A render the host cannot take (hover, some presses) is "unverified", never "looks right".

## Design process (mandatory for any UI change)

Skills live in `.agents/skills/` (linked into `.claude/skills/`; its `README.md` lists them). The `herdr-*` skills carry the product judgement, the `emil-*` skills the craft; `DESIGN.md` wins where they disagree. In order:

1. **`herdr-design`**: the moment, the regions, the density tier, the journey, the noise ledger and a **reference teardown** (the Claude desktop app, Linear or Zed: what each region does that ours does not). Never design from this repo's docs alone.
2. **Craft** by what you touch: `emil-design-foundations`, `emil-typography`, `emil-surfaces`, `emil-color`, `emil-ui-polish`, `emil-forms-and-inputs`, `emil-animations` with `herdr-motion`, `emil-component-design`, `emil-touch-and-accessibility`. Their rules are written for the web: keep the value (4-pt scale, outer minus padding, tabular figures) and translate the unit to nsh classes.
3. **`herdr-prototype`** when the path is open: 2 to 4 directions, each moving one axis, on the same data.
4. **`herdr-screen-check`** to render and look at every width and theme.
5. **`herdr-critic`** before calling a UI change done (a fresh reviewer sees only the PNGs and the five questions), then `herdr-review` and `emil-ui-review` on the diff. **`herdr-test`** for any test.

## Commands

```sh
make                       # verify: nsh check, tests, core (fmt+clippy+test), docs, a11y
make test                  # nsh test with the test seam open (the only safe way to run the suite)
nsh check                  # types: must print nothing
make lint | fmt            # oxlint --deny-warnings | oxfmt; format the files you edited, not the tree while others edit
make core                  # cargo fmt/clippy/test of native/core and native/app
make docs                  # DESIGN.md < 100 lines, design/*.md < 150, every backticked name exists
make a11y                  # AT-SPI tree of every screen, no unnamed control (Linux)
make run | package        # dev window | package under .scratch/dist
make shots-mac | shots     # a screenshot of the app's own window (macOS | Linux): docs/DEVELOPMENT.md
make perf-check            # scenarios in a real window against .perf/budgets.json (Linux)
```

Run `nsh` and `cargo` with the repo root as the working directory (rustup pin `rust-toolchain.toml`). `.cargo/config.toml` sets one shared `target/`: never create a second target directory, the data disk is nearly full. Build needs and the rest: `docs/DEVELOPMENT.md`.

## Map

```
App.tsx, App.test.tsx   shell, keymap, routes; the end-to-end tests
components/*.tsx        one file per screen or part, kebab-case; components/kit/ is the UI kit (import "#kit")
lib/                    TSX state and rules, no screens
native/core/            crate herdr-core: pure Rust, no nsh
native/app/             crate herdr-desktop-native: the nsh native module
design/, DESIGN.md      the design system        docs/   architecture, accessibility, performance, development, releasing, status
fixtures/  scripts/     synthetic herdr data; build, shots, audit and check scripts
.perf/ .shots/ .a11y/   scenarios and budgets (hidden: nsh test skips them)
.agents/skills/         project skills        .scratch/   gitignored scratch (screenshots, builds, plans): never /tmp
```

`components/*-probe, *.fixture, *-lab .tsx` are test entries, not the app.

## Read first

| You are changing | Read |
|---|---|
| any UI | `DESIGN.md`, `design/taste.md` |
| colour, theme, text, spacing, sizes | `design/colors.md`, `design/themes.md`, `design/typography.md`, `design/foundations.md`, `lib/layout.ts` |
| attention, the sidebar, the Board | `design/attention.md`, `design/components.md`, `design/board.md` |
| chat, tool calls, the dock, the composer | `design/chat.md`, `design/chat-parts.md`, `design/composer.md`, `design/code.md` |
| fields, menus, popups, controls, dialogs, toasts | `design/forms.md`, `design/menus.md`, `design/overlays.md`, `design/controls.md`, `design/dialogs.md` |
| tables, files, anything that moves | `design/data.md`, `design/files.md`, `design/motion.md` |
| accessibility, keyboard | `docs/ACCESSIBILITY.md` |
| nsh behaviour on this host, macOS | `docs/DEVELOPMENT.md`, `docs/MACOS.md` |
| threads, links, data flow, herdr protocol | `docs/ARCHITECTURE.md` |
| what is built and open | `docs/STATUS.md` |
| CI, a release, release notes | `docs/RELEASING.md`, `.agents/skills/herdr-changelog/SKILL.md` |

## Code rules

- **Formatting and lint are oxc's** (`.oxfmtrc.json`, `.oxlintrc.json`, `--deny-warnings`): never hand-format; a lint rule that fights nsh style is switched off in the config with the reason next to it.
- **Project imports are absolute** through `package.json` `imports` (`#lib/`, `#components/`, `#kit`); never `../` for project code. `node scripts/absolute-imports.mjs --check` is part of the check.
- **File names are kebab-case** for every `.ts`/`.tsx` file; the exported component keeps its PascalCase name. Tests sit beside what they test; test entries end in `-lab`, `-probe` or `.fixture`. Rust files are `snake_case.rs`.
- UI is built from the kit; a screen never pastes a kit component's class string. Colour is a semantic token class, never hex or `rgb()`. Design values live once (`lib/layout.ts` and the `tailwind` block of `nsh.json` agree, and a test enforces it).
- Global shortcuts live in `lib/shortcuts.ts` once, always with `mod`, never `alt` (AltGr is Ctrl+Alt); never `mod+q` or `F11`. A menu letter acts only while that menu is open.
- `lib/` imports no screens. The kit imports only `lib/motion`, `lib/perf`, `lib/shortcuts`, `lib/settings`, `lib/text`: keep that one-way (a signal the kit needs goes in one of those). Domain persistence is Rust; TSX holds UI-only state.
- Comments say why, never what. Docs change in the same change as code (`make docs` fails otherwise); describe unbuilt things in plain words, without backticks.
- No tiny one-expression wrappers unless used three or more times. Never `ReturnType<typeof fn>`. Top-level `import type`.
- Rust: `cargo clippy -- -D warnings`, no `unwrap` on I/O, no allocation per row on a hot path.

## Tests

- Test what a person would notice: behaviour, boundaries, transitions, errors, precedence. Never wiring, copies, source text, incidental defaults or wording; delete such a test instead of re-pinning it. A bug has a test that failed before the fix; a safety guard has a test that fails when the guard is removed (remove it once to check).
- A test never depends on the clock or the CPU: poll for the condition, await the event, or inject a clock. Never read the screen right after a press.
- End-to-end tests run against the fake herdr only and select by accessibility label. The helpers and the flake families found are in `herdr-test`.
- The headless runner has no hover and no text layout: say so instead of claiming a look.

## Definition of done

1. `make` is green, and a failure that appeared only in the full run was re-run alone and explained.
2. A UI change was looked at: a render at 1280, 960 and 760, light and dark, large text; compared with the Claude desktop app for the same moment; `design/taste.md` checked by eye; passed `herdr-critic`. On a Mac only `make shots-mac` renders: say what it cannot show (hover, some presses) is unverified.
3. Docs updated in the same change; `docs/STATUS.md` if something was built or opened; a `CHANGELOG.md` bullet for a feat or fix.
4. A performance-sensitive change reports the scenario deltas of `docs/PERFORMANCE.md` (Linux).
5. Nothing stray outside `.scratch/`; real pane data never reaches git, logs or screenshots.
6. The report says what was verified and what was not.

## Commits

Semantic (Conventional Commits): `type(scope): subject`, imperative, lower case, at most 72 characters, no full stop. One logical change per commit; the body says why and what was measured or left unverified.

- **Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`. `!` or a `BREAKING CHANGE:` line when a stored format or wire contract changes.
- **Scopes:** `core wire link ssh board prompt screen pane session observed kit theme a11y notify files perf`. Leave it out when a change spans many.
- The remote is `origin` = `https://github.com/tuan3w/herdr-desktop.git`. Release commits are `chore(release): x.y.z, <headline>`; the tag is what `release.yml` reads.
- **Release notes are `CHANGELOG.md`, for the person using the app.** A feat or fix commit adds a bullet under `## [Unreleased]`; a release rewrites it per `herdr-changelog` and checks it with `node scripts/check-changelog.mjs x.y.z`. Pictures are never committed: they are release assets.
- CI on push is macOS only; the slow checks and Linux are run by hand before a release (`docs/RELEASING.md`).

## Writing things down

- **Screenshots are not committed**, except the three the README shows (`docs/screenshots/`).
- Facts go next to what they describe: a hard-won fact about a subsystem goes in its doc under `docs/`, with the reason and the failure that taught it. A rule learned from a correction says what the correction was.
- `DESIGN.md` is the design system, not a changelog. This file is the working agreement, not a status report.
- Mark what was not measured or run (unverified), so a claim never outlives its evidence.
