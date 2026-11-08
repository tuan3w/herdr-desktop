---
name: herdr-changelog
description: Writes and checks Herdr Desktop's release notes and their pictures. It adds `## [Unreleased]` bullets for a feat or fix change; at release time it rewrites them into the `## [x.y.z]` section (headline, one-paragraph outcome, Try-it cards, short bullets, Fixed, Not checked), renders a still of each new screen from the scripted `.shots` scenarios, and uploads the pictures to the GitHub release. Use it whenever a release is being prepared, the version is bumped, a feat or fix commit lands, or someone asks for a changelog, release notes, what's new or patch notes, even if they don't name the skill.
---

# Writing Herdr Desktop's release notes

Ported from herdr-mobile's skill of the same name. What changed in the port: the reader uses a computer, the labels live in `components/*.tsx` and `lib/*.ts`, the stills come from `.shots`, and there is no walkthrough clip (see the end of section 6).

## 1. Who reads it

The person from `AGENTS.md`: someone whose agents work while they are elsewhere, on a Mac (or a Linux box), with seconds of attention. They read the notes in two places:

- the GitHub release page: the `## [x.y.z]` section of `CHANGELOG.md`, verbatim (`scripts/release-notes.sh x.y.z`, which `release.yml` runs). The `edge` pre-release shows the `## [Unreleased]` section the same way.
- `CHANGELOG.md` itself in the repository.

(`Settings > About` only offers `Open release page`: it does not render the notes.)

They want to know what they will notice and where to find it so they can try it. Never the commits.

## 2. Two moments

- **A feat or fix commit** adds bullets under `## [Unreleased]` (create the heading at the top if it is missing), one per thing the person notices, by the rules of section 4. No headline, no tips, no pictures yet. `edge` shows these bullets.
- **A release** rewrites `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` in the format of section 5, keeps a fresh empty `## [Unreleased]` above it, and makes the pictures (section 6). The first `### headline` is also the release commit's subject, in lower case: `chore(release): x.y.z, <headline>`.

`release.yml` fails before building when the tag's section is missing or empty (`scripts/release-notes.sh`) or breaks the format (`scripts/check-changelog.mjs`).

## 3. Gather (release moment)

```bash
git describe --tags --abbrev=0                       # the previous release, e.g. v0.1.0-alpha.3
git log --no-merges --format='%h %s%n%b' <tag>..HEAD
```

- Keep `feat`, `fix` and `perf` commits. Drop `refactor`, `test`, `docs`, `build`, `ci` and `chore` unless the body says the person notices something.
- Drop a commit together with its `Revert`: a feature that landed and was reverted inside the range never reached anyone, so it gets no word, not even "removed".
- When a subject does not say what the person sees, read the diff until you can say it.
- Check both ways: every `## [Unreleased]` bullet traces to a surviving commit, and every person-visible commit has a bullet. A bullet without a commit is a promise the build does not keep; a commit without a bullet is a change the person meets unannounced.

## 4. Writing rules

- **UI labels in backticks, exactly as in the app.** `Copy code`, `Answer one by one`. The person looks for those letters; a paraphrase sends them hunting. Grep the label as a quoted string in `components/` and `lib/` and read the component that shows it, so you name the place too (`grep -rn '"Copy code"' components lib`).
- **Shortcuts as the person presses them:** `Ctrl+P`, and `Cmd+P` where a Mac differs (`lib/shortcuts.ts` has the keys; `mod` is Cmd on a Mac and Ctrl elsewhere). Say which when the platform changes the answer.
- **Agent names:** Claude Code, Codex, omp, pi. Never `claude`, never "the AI".
- **A fix says what went wrong in the person's terms, then "no longer…".** Name the real cause and place; a fix line that blames the wrong screen plants a false memory.
- **State platform conditions:** "on macOS 15 and later", "on Linux". A claim true on one system and false on another is a bug report waiting to happen.
- **Mark what was not verified**, in `**Not checked**` at the end: macOS has never been run by the author on a real Mac; say it when a change touches a platform behaviour that only a Mac can show.
- **Numbers with units, outcome first:** "a 600-message chat took 1.5 s to open, it takes 0.2 s".
- **No file names, component names, commit hashes, PR numbers, source paths or the word "refactor".** They mean nothing to the person and date the note.
- **One word per thing in a section:** "a pane", "a chat", "the sidebar". A tip is followed by mapping its words onto the screen; three names for one place break that.

## 5. The release section (outcome-cards)

```markdown
## [0.1.0-alpha.4] - 2026-11-20

### Pictures are kept between runs

A picture you looked at is kept on your computer, so opening it again no
longer downloads it.

> [!TIP]
> Try it: in a chat, click a picture, close the chat and open it again.

- At most 192 MB is kept; the oldest pictures go first.
- Chats of agents running in a terminal show your pictures as a quiet line
  with the size and type; click it to load the picture.

![A chat with a picture and its size line below the message](https://github.com/tuan3w/herdr-desktop/releases/download/v0.1.0-alpha.4/0.1.0-alpha.4-pictures-kept.png)

**Fixed**

- A picture in a chat larger than about 100 KB no longer vanishes when the
  chat reconnects.

**Not checked**

- Not measured on a Mac.
```

- **The headline** (`### `) names the outcome in the person's words, sentence case. Usually one or two per release; a release with several unrelated themes has one block each.
- **The paragraph** is one or two sentences: what the person can now do.
- **Bullets** are the rest of what they notice, one or two lines each. Keep the facts that answer "can I trust it" (what happens when the connection drops, conditions such as "even with notifications off"): shortening must not drop a recovery promise.
- **`**Fixed**`** goes at the end of the section, never inside a headline block, never as a tip. **`**Not checked**`** is last: honest, specific.
- **Wrap lines at about 78 characters.** GitHub reflows soft breaks.
- **Try-it cards:** `> [!TIP]` then `> Try it: <path>`. GitHub draws a card; a reader that drops the card chrome still reads a step. Only for something new that the person has to find (a fix, a speed-up or a change they meet anyway gets none); at most 3 per release; each right after the fact it teaches. The path starts where the person already is ("in a chat", "in the palette") and uses labels you found as quoted strings. An icon-only control gets its shape and its label. Never name a label the app no longer has.

## 6. Media: stills, as release assets, never in git

The `AGENTS.md` rule stands: pictures are not committed (the README's three images are the one exception). A picture of a release is an **asset of that release**, named `<version>-<slug>.png|jpg|mp4` (`<slug>` = 2 to 4 kebab-case words of the headline), referenced in the notes by `https://github.com/tuan3w/herdr-desktop/releases/download/v<version>/<version>-<slug>.png`. Each `###` block ends with at most one still (`![what it shows](url)`, 4 words or more: a reader that cannot load the picture shows only that text). Fixes get none. A release with nothing worth showing ships without pictures.

Work in `local/release-media/<version>/` (git-ignored).

1. **Find the scenario.** `.shots/scenarios.ts` lists the screens (`board`, `agent-chat`, `pane`, `triage`, ...) on scripted data: the fixture herdr, never a real pane. `grep -n '<label>' .shots/scenarios.ts`.
2. **No scenario shows the new state?** Add one (it is the screen's regression picture too).
3. **Render** (Linux, cairo under Xvfb): `make shots`, or one scenario: `dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo nsh test .shots/screens.test.tsx --target linux --filter "<scenario> light 1280"`. Open the PNG and look: the new thing must be visible without explanation, light theme, 1280 px wide, no private text. Copy it to `local/release-media/<version>/<version>-<slug>.png` (under 1.5 MB).
4. **Check before the tag:** `scripts/release-media.sh <version>` (every picture the notes name is a file there).

### Upload, after the release workflow

`release.yml` creates the release from the tag; do not create it yourself. Wait for it, then upload and check that every link resolves:

```bash
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
scripts/release-media.sh <version> --upload     # gh release upload v<version> local/release-media/<version>/*, then HTTP 200 for each URL
```

Extra assets are safe: `scripts/install.sh` picks its download by exact name from `SHA256SUMS`, and the workflow's checksums cover only the app archives. GitHub's edge may answer 404 for a minute for a URL asked before the upload; the script sends `Cache-Control: no-cache` for that.

A walkthrough clip is optional and not set up here: herdr-mobile's skill (`herdr-mobile/.agents/skills/herdr-changelog`) has the recording and framing recipe for a phone; a desktop recipe would need a screen recorder on the Mac and has not been written.

## 7. Check

```bash
node scripts/check-changelog.mjs <version>        # a release
node scripts/check-changelog.mjs unreleased       # a feat/fix commit
scripts/release-media.sh <version>                # the pictures exist (--remote after the upload)
```

It checks the section exists and has `###` headlines, at most 3 Try-it cards each with its `> Try it:` line, no hashes, PR numbers, file names or source paths outside backticks, lines of at most 80 characters, and that every picture is an asset URL of this version named `<version>-<slug>` with a description of 4 words or more. It cannot judge whether a bullet is true, whether every commit is covered, or whether a tip's path works: read them (section 3) and follow each tip once in the app.

Then commit `CHANGELOG.md` and the version bump in the release commit. The pictures stay out of git.
