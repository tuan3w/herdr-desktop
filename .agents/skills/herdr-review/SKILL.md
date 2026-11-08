---
name: herdr-review
description: Review herdr-desktop code for bugs, UI/UX problems and maintainability, and reproduce every serious finding before reporting it. Use it whenever someone asks to review, audit, check, look over, find bugs in, "is this safe to commit/merge/release" or "what's wrong with" a diff, a commit, a branch, uncommitted changes, or a named area (the engine, the answer path, the kit, a screen), and before committing or releasing non-trivial work, even if they only say "take a look". For a change it reviews the diff and what the diff can break; for an area it runs a multi-lens sweep. UI is judged from code; for rendered judgement it hands off to herdr-screen-check and herdr-critic.
---

# Reviewing herdr-desktop

A review is worth the bugs it finds that the owner would otherwise ship. It fails in two ways: the reviewer reads what the code is *meant* to do (the author's view), and it reports guesses as facts. So: read what the code does, name the input that breaks it, then prove it before you say it.

This skill reads code. `herdr-design` decides what a screen should be, `herdr-screen-check` and `herdr-critic` judge pixels, `herdr-motion` judges movement, `herdr-test` says how tests are written and run, `emil-ui-review` is the general craft review of a UI diff. Where a finding needs pixels, say "from code, not seen" and name the skill that settles it.

## 0. Hard rules (each from a failure; give them to every subagent)

- **`HERDR_DESKTOP_TEST=1` or `make`.** Never run `nsh test` bare: the fixture seam stays closed and the app under test connects to the owner's real herdr and machines (it read real project names once). Use `make test`, `make test-smoke`, or `HERDR_DESKTOP_TEST=1 nsh test <file>`.
- **Never kill a process you did not start.** No `pkill -f`, `killall`, name kills. The owner's training runs, agents and herdr itself share this machine. Keep the PID of what you spawn.
- **Never call a mutating herdr method against the live herdr** (an empty `tab.create` creates a tab). Tests use the fake server; live smoke is read-only (`ping`, `session.snapshot`, `pane.read`, `agent.list`) or a scratch workspace `herdr-desktop-scratch`, `focus: false`, closed after.
- **Pane screens are private user data.** Never open, log, screenshot or commit a real pane. Fixtures are synthetic.
- **Nothing is approved silently.** The answer path re-reads the pane and refuses when the question changed; no timer, default or notification sends an answer. Anything typed into a remote shell is validated or `shq()`-quoted, with an injection test; a destination is validated and follows `--`. No secret on a command line, in a log or in a fixture.
- **A full suite may be running in this checkout.** Do not start a second one unless told; prefer one test file by name.
- **The working tree holds other people's work.** Never stash, checkout, reset, format or `git clean`. Reproduce in a clean copy, never the main tree.
- Scratch lives under `.scratch/` (gitignored), never `/tmp`. Never commit or push unless asked.

## 1. Pin what is reviewed

- **A change** (default): "my changes", a commit, a branch, uncommitted work. The base is the commit it started from (`HEAD` for uncommitted work).
- **An area** (only when asked): a subsystem, directory or "audit X". Go to section 6.
- The tree is routinely dirty with unfinished work (the status at session start often lists dozens of files). Review only the files that belong to the change, list the rest as out of scope.
- Run `bash .agents/skills/herdr-review/scripts/review_packet.sh [base]`. It lists changed files in risk order (native Rust, then `lib/` and the kit, then screens, then tests), the tests and docs that name each one, and exported names the change removed that are still referenced (a clean cutover leaves none). It is the plan, not the review.
- Read the intent: the commit message, the plan, the owner's words. Intended behaviour is not a finding unless it breaks a rule in `AGENTS.md` (then it is a decision for the owner).

## 2. Read around the diff, not only in it

The bug is usually in what the diff assumes about code it did not touch. For each changed symbol:

- Its callers (`find_references` or grep) and what they assume.
- Every consumer of a value the change adds (a status, a fixture name, a setting, a shortcut id, a wire field). Read each switch and filter; a new value that lands in a default branch is the classic miss. Wire facts come from `docs/herdr-api.schema.json`, not memory.
- Its twin: the same job done elsewhere (the sidebar and the Board both read `projectLines`; the answer dock and the bulk answer share the rules; menus and popups share `popup.ts`). A fix to one copy and not the other is a bug (principles 6 and 10).
- The subsystem's doc (`docs/ARCHITECTURE.md`, the matching `design/*.md`) and the test beside it, and what it actually pins.
- What the change deleted: callers of removed things, comments and docs that now say something false, `design/*.md` that still describe a cut-over piece.

## 3. Three lenses on every changed file

Bugs first: polish on wrong behaviour is decoration.

| Lens | Question | Reference |
|---|---|---|
| **A. Bugs** | What input or state makes this code do the wrong thing, and who hits it? | `references/bug-classes.md` |
| **B. UI/UX, from code** | Which of the five questions does this serve, and where does it lie, strand or surprise the person? | `references/ux-from-code.md` |
| **C. Maintainability** | Will the next change break because of this, or the next reader be misled? | `references/maintainability.md` |

Read a lens's reference when the diff touches its ground: bug classes for any logic, the UI reference for anything under `components/` or `lib/` screens, maintainability for anything that adds, copies, renames or deletes code. Run the gates that exist before reasoning: `nsh check` (types, must print nothing), `node_modules/.bin/oxlint --deny-warnings`, `node_modules/.bin/oxfmt --check`, `node scripts/absolute-imports.mjs --check`, `node scripts/check-docs.mjs`: these are static and safe on a dirty tree (they check the whole tree, so attribute only failures in the files in scope).

## 4. What counts as a finding

A finding has all of these; without them it is a **lead** (confidence under 0.5, listed apart):

1. **Trigger:** the concrete input, state or sequence. "Might", "could", "consider" is not one.
2. **Who:** which person or run reaches it, and how often. A bug only a hand-edited file can reach is P3 however bad it looks.
3. **Evidence:** `file:line` and the code quoted exactly as it is.
4. **Confidence:** 0 to 1: `ran` 0.9 and up, `read` 0.5 to 0.8, `lead` below 0.5.

Priority, by what happens to the person:

- **P1:** silent or stale approval, an answer sent to the wrong pane or question, data loss, a secret leaked, a command injected on a remote, a freeze of the UI thread, a dead end with no way out.
- **P2:** visibly wrong behaviour, typed work lost, a stale or offline machine shown as live, a likely leak, a state counted twice, a global shortcut that steals typing.
- **P3:** rare, narrow, or maintainability.

UI/UX findings also use `herdr-design`'s words: Broken, Friction, Noise, Inconsistent, Polish.

**Not findings:** behaviour the commit message or plan states as intended; code the change did not touch and does not depend on; a decision `DESIGN.md` or `AGENTS.md` records with a reason (reopen only with new evidence, and say what it is); style no rule states (oxfmt decides formatting); missing comments or types; anything you only suspect (that is a lead).

## 5. Prove it before you report it

Every P1 and P2 bug claim, and any claim the owner would act on, gets one more step:

1. **Try to break it with a throwaway test in a clean copy** (`references/reproduce.md` has the commands, the seams and the platform limits). A pure function needs no harness. Never in the main tree.
2. **Record how it was checked:** `ran` (the test failed on this code the way the finding says; keep the output), `read` (traced by reading every step; say why it could not run), `lead` (not verified; never stated as fact).
3. **Set the priority after, not before.** Ask who can trigger it. Move it down when the trigger needs something no person or run produces; keep a down-rated finding listed.
4. **Say what you could not check:** a real GTK or AppKit window, GPU frame times, a real ssh hop or relay, VoiceOver and Orca, keyboard focus in AppKit, notifications. Name them. Never quote a Linux or Xvfb number for a Mac or a real GPU.
5. A flaky test is a finding too (`herdr-test`: presses landing during pane-read re-renders, swallowed 5 s timeouts): check by waiting on the fact, not on time.

If you have subagents, verify with a fresh one given the finding (symptom, `file:line`, trigger) and not your severity reasoning, so it tests the claim instead of agreeing. If you have none, write the reproduction down before you reread your own report.

## 6. Area sweeps (only when asked)

Breadth was asked for, so spend it.

- **Round 1, by ground:** `native/core` (wire, link, ssh, store, board, prompt, screen); `native/app` (module API, `PaneScreen`, notify); `lib/` state and rules; `components/kit`; `components/` screens by feature (chat, Board and sidebar, changes and files, palette and menus); `scripts/`, `Makefile`, CI. One read-only subagent each; a small area gets one per lens.
- **Round 2, by lens,** only when round 1 was dense: lifecycle, error classification (fatal vs retryable), the answer path, remote-shell quoting, performance (UI-thread work, per-row allocation), accessibility, tests and docs. Tell each what is already known and to skip it.
- **In every reviewer's task text:** it must not edit files; it must not kill any process; `HERDR_DESKTOP_TEST=1` or `make` for anything that runs; never touch a real pane or the live herdr; it cites `file:line` and quotes the code; it gives the trigger and a confidence per finding; at most ten findings.
- **Then verify** with section 5, one fresh agent per P1 or P2 (small ones may share one), each in its own copy. Merge duplicates; a claim the verifiers could not confirm goes under leads.

## 7. Report

Short and ranked; ten findings that matter beat thirty.

1. **Verdict:** `Block` (a P1, or a P2 the change introduced), `Approve with conditions` (list them) or `Approve`, one line why.
2. **Bugs, worst first:**

   | # | Pri | Class | Trigger and who | Evidence (`file:line`, code) | Checked | Fix |
   |---|---|---|---|---|---|---|

   `Checked` is `ran`, `read` or `lead`, with the command or test name for `ran`.
3. **UI/UX, from code,** in `herdr-design`'s table, each marked "from code, not seen" unless a render was opened (and which platform).
4. **Maintainability:** same table; each row says what breaks later.
5. **Leads:** unverified, with the check that would settle each.
6. **Decisions for the owner:** questions with more than one right answer, with a recommendation; any documented decision you think should be reopened, with the evidence.
7. **Not checked** and **what held up**, so nobody "fixes" it. Out-of-scope files you saw modified.
8. **What gates ran** (`nsh check`, oxlint, oxfmt, `make docs`, tests by file) and which did not, and why.

Fix only if asked. When asked: fix the confirmed findings, keep each reproduction as a regression test that fails before and passes after (`AGENTS.md`, "Tests": behaviour a person would notice, never wording or wiring; delete a test that pins either), and run the gates. Commits are semantic, one logical change each, with a `CHANGELOG.md` bullet under `## [Unreleased]` for a feat or fix.

## Never / Instead

| Never | Instead |
|---|---|
| "This might race" with no sequence | The interleaved steps, numbered, or a lead |
| P1 because it looks bad | P1 because of what happens to the person, after asking who triggers it |
| A finding on a changed line only | Callers, consumers of added values, and the twin |
| Reproduce in the main working tree | A clean copy under `.scratch/` (`references/reproduce.md`) |
| `nsh test` bare, or a second full suite | `HERDR_DESKTOP_TEST=1` and one file, or `make test` |
| Stash, checkout or format to get a clean tree | Review the files in scope; list the rest as out of scope |
| Praise or "looks good overall" | The checked list under "what held up" |
| Re-argue a documented decision | New evidence, or leave it |
| "Fixed" without a test that failed first | A reproduction kept as a regression test |
