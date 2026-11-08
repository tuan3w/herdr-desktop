# Project skills

Skills for working on herdr-desktop, kept in the repo so every tool and every sub-agent has the same ones. `.agents/skills/` is the source; `.claude/skills/<name>` is a relative symlink to it (`../../.agents/skills/<name>`). A new skill goes here and gets a link there.

**Precedence.** `AGENTS.md` beats `DESIGN.md` and `design/*.md`, which beat the `herdr-*` skills, which beat the general `emil-*` skills. The `emil-*` skills are general guidance written for the web (React, CSS): where one disagrees with `DESIGN.md` or `AGENTS.md`, **`DESIGN.md` wins**. Keep the value of a rule (a 4-pt scale, outer radius minus padding, tabular figures) and translate the unit to nsh classes. Where a skill and the code disagree about a fact, the code wins: fix the skill.

## The order of a UI change

1. **`herdr-design`**: the moment, the regions (sidebar, main, inspector, status), the journey, the density tier, the noise ledger and a reference teardown. Never design from this repo's docs alone.
2. **Craft**, by what you touch: `emil-design-foundations`, `emil-typography`, `emil-surfaces`, `emil-color`, `emil-forms-and-inputs`, `emil-component-design`, `emil-ui-polish`, `emil-animations` with `herdr-motion`.
3. **`herdr-prototype`** when the path is open: 2 to 4 directions, each moving one axis, on the same data.
4. **`herdr-screen-check`**: render and look at every width, theme and `fontScale()` 2.0 (`make shots` on Linux, `make shots-mac` on a Mac), `make a11y` on Linux.
5. **`herdr-critic`**: a fresh, blind reviewer sees only the PNGs and the five questions.
6. **`herdr-review`** (bugs, UI from code, maintainability, reproduced before reported) and `emil-ui-review` (craft) on the diff.
7. **`herdr-test`** throughout: how to run and write the tests the change needs. **`herdr-changelog`** at release.

## herdr skills

| Skill | Use it when |
|---|---|
| `herdr-design` | any product, UX or layout decision; a new screen, a flow, copy, "denser", "feels off", a design review. Has `references/journeys.md` and `references/foundations.md`. |
| `herdr-prototype` | the best path is unclear, the owner says "mock it up" or "compare options", or before a non-trivial layout, sidebar, Board or inspector change |
| `herdr-screen-check` | before calling any UI change done; screenshots, stress tests, large text, a11y audit. Has `references/worst-case.md`. |
| `herdr-critic` | a second opinion on rendered screens, "which is better", a comparison with another app. Blind by design. |
| `herdr-review` | review a diff, a commit, a branch or an area; "is this safe to merge". Has `references/` and `scripts/review_packet.sh`. |
| `herdr-motion` | any animation, transition, popover, dialog, toast, arrival, loop, or "make it feel better". Has `references/recipes.md`. |
| `herdr-test` | run, write, debug or review a test or lab; flaky tests; `make test` vs one file; macOS vs Linux limits |
| `herdr-changelog` | write or check release notes (`CHANGELOG.md`, `scripts/check-changelog.mjs`) |

## emil-* skills (general craft)

Copies of the `emil-*` set that ship-desk (the sibling nsh app) carries, the same way: real files in `.agents/skills/`, no per-tool rewriting. Only the ones that apply to a native desktop app are here. Skipped on purpose: `emil-mobile-native` (phones), `emil-marketing-pages` (web pages), `emil-ask-emil`, `emil-ask-lapse`, `emil-borrow-a-brain`, `emil-build-a-tool`, `emil-get-creative` (not part of building this app).

| Skill | Use it when |
|---|---|
| `emil-design-foundations` | hierarchy, spacing, one primary action, empty states and error copy; "looks off" |
| `emil-typography` | type scale, truncation, tabular figures, fonts |
| `emil-surfaces` | nested radii, hairlines, shadows, dark surfaces |
| `emil-color` | tokens, contrast, themes, tonal scales |
| `emil-forms-and-inputs` | the composer, fields, validation, buttons, Enter and Cmd+Enter |
| `emil-component-design` | the kit's APIs: composition, controlled and uncontrolled |
| `emil-ui-polish` | invisible details: hit areas, focus, layout shift, selection, truncation |
| `emil-touch-and-accessibility` | keyboard, focus, reduced motion, hit targets (the touch parts matter little on a desktop) |
| `emil-animations` | whether and how to animate, easing, springs; read `herdr-motion` first for this repo's tokens |
| `emil-performance` | lists, layout shift, transitions, keeping animation out of renders |
| `emil-prep-for-prod` | a pre-ship pass over states, forms, motion, accessibility, content |
| `emil-ui-review` | review a UI diff the way a design engineer would; pair with `herdr-review` |
| `emil-design-system-docs` | writing or updating `DESIGN.md` and `design/*.md` so an agent can follow them |
| `emil-prototype` | general prototyping method; `herdr-prototype` is this repo's version and wins |
| `emil-product-thinking` | what to build and what to cut |
| `emil-design-vocabulary` | naming an effect or a pattern precisely |
| `emil-unslop-design`, `emil-unslop-writing`, `emil-unslop-code` | strip generic-AI tells from UI, copy and code |
| `emil-writing-skills` | writing or revising a skill |

## Working rules that every skill repeats

- **`HERDR_DESKTOP_TEST=1`**: never run `nsh test` bare; use `make test`, `make shots`, `make shots-mac`, or set it. Give every sub-agent this rule.
- **Never kill a process you did not start.** Keep the PID of what you spawn.
- **Pane screens are private.** Fixtures and screenshots are synthetic; never commit, log or screenshot a real pane.
- Scratch lives under `.scratch/` (gitignored), never `/tmp`. Screenshots are not committed.
- Mark what was not run or not seen **unverified**: on macOS no Linux render, `make a11y`, perf or cpu exists.

## Adding or changing a skill

A skill is a folder with a `SKILL.md` whose frontmatter has `name` (the folder name) and a trigger-rich `description` (what it does and when to use it, including the phrasings people use without naming it). Keep `SKILL.md` under about 250 lines and put depth in `references/`. Cite repo files; never invent a fact about this repo: read the code or doc. No validator is vendored here; herdr-mobile's `.agents/skills/skill-creator/scripts/quick_validate.py` (run as `python3 -I quick_validate.py <skill dir>`) checks frontmatter (it rejects angle brackets in the description). Link it: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
