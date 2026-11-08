# Worst-case catalog for herdr-desktop

Each value is something a real person, machine or agent produces. Use the rows that apply to the values on your screen. Use `example.com` or `.test` for anything that looks like a host. All data is synthetic: put it in a fixture of the fake herdr (`fixtures/herdr/`) or in a lab through `Herdr.testSetSnapshot`, never a real pane (`AGENTS.md`).

## Machines and links

| Value | Breaks |
|---|---|
| `build-box-gpu-02.tail9f3c1.ts.net` | A long host with no spaces: end-truncation hides what differs; the project header's muted machine name |
| `fe80::1ff:fe23:4567:890a%wlan0` | IPv6 with a zone: colons, width, shell quoting (`shq()`) |
| `mac` / `a` | One to three letters: an empty-looking header |
| `Máy chủ phát triển` | Vietnamese machine name, stacked diacritics |
| 0 machines | First run: what does the person do next? |
| 1 machine (this computer) | No machine name anywhere: the screen reader still hears it |
| 12 machines, 3 offline, 1 stale, 1 changed host key | Every link state at once; footer line and amber names stacking |
| The same project on two machines | Two groups, each its own branch and working copy |
| A disabled machine | Shown dimmed or hidden? |

## Agents, projects and sessions

| Value | Breaks |
|---|---|
| Programs `claude`, `codex`, `omp`, `pi`, `opencode`, unknown (shown as the inspector and tooltip say) | Per-agent tables, which view opens (`canObserve`), the composer note |
| A title of 120 characters with a path in it | A one-line row: `Clipped` and the full text on hover |
| Two agents with the same title in one project | Rows that cannot be told apart; what distinguishes them? |
| `Thiết kế giao diện · Đặng Thị Ngọc Hân` | Diacritics clipped by a tight height |
| `修复登录问题` / `إصلاح تسجيل الدخول` | No spaces, RTL punctuation and alignment |
| `🦊 refactor` | Emoji first: truncation, the monogram |
| 0, 1, 40, 120 agents over several machines | Empty board, a single row, the virtual list (`List`), the idle fold (`N more idle`) |
| 5, 25 or 40 waiting at once | One mark per row not ten plus counts; the marked row below the fold; `mod+j` walk |
| A project folded while two agents wait | The folded header shows the count; open it shows none |
| Every status at once: needs you, working, done, idle, unknown, offline | Glyph shapes without colour; stable order (a row never moves) |
| A blocked terminal whose prompt the detector cannot read | No one-press answers: what does the dock say? |
| A stale or offline machine's agent | Dashed glyph, dimmed, never counted as waiting, never answerable |
| An agent that finished while away | `To review`, `Reviewed` on hover and focus, one Undo |

## Commands and questions (what the person approves)

| Value | Breaks |
|---|---|
| `git push --force-with-lease origin feature/very-long-branch-name-for-the-payments-api-refactor` | One unbreakable line in a mono block: wrap, never cut |
| A 4,000-character multi-line heredoc | The dock's "up to six rows" and its way to the rest; nothing silently cut |
| `rm -rf "$HOME/projects/old build"` | The risky two-step, `Press again to send · <reason>`, the 4 s disarm |
| A command with a bidi override (U+202E) or control characters | The text shown must equal the text run (`visibleText`) |
| An ANSI-coloured question | Escapes stripped, not shown raw |
| Options `1. Yes`, `2. Yes, and don't ask again`, `3. No, and tell Claude what to do differently (esc)` | A long option label on a chip that cuts what it grants; a standing grant needs two steps |
| 9 options | `N more` in the dock |
| A question that changes while the person reads | `The question changed`; a press within 400 ms is ignored and dimmed |

## Paths and files

| Value | Breaks |
|---|---|
| `/home/dev/work/clients/northwind/payments-api/src/features/checkout/widgets/order_summary_card.tsx:212` | Middle-truncation; a link into the inspector |
| `~/Tài liệu/Hợp đồng thuê nhà.pdf` | Diacritics and spaces in a path |
| `IMG_20250914_183022_HDR_portrait_edited_edited.HEIC` | An unbreakable name with an uppercase extension |
| A folder of 0, 1 and 5,000 entries | Empty, one, a virtual list |
| A 40 MB image, a 2 GB log, a binary | Size caps, progress, the hex preview |
| A file without read permission, a dangling symlink | Errors that say what to do |
| A diff of 3,000 lines in 200 files | Changes list and diff virtualization, `changes-many` scenario |

## Terminal and chat content

| Value | Breaks |
|---|---|
| 200-column output, a table, box drawing | `PaneScreen` scales its font to fit and scrolls sideways rather than shrinking below a readable size |
| Pale grey truecolor text on a dark pane inside a light window | `term-*` contrast remap |
| CJK and emoji (double width) | Cell width in the pane rows |
| 1,000 rows of scrollback then 3,000 streamed | Capped history, `New output` pill, jump to latest |
| A spinner redrawing one line ten times a second | No motion or relayout elsewhere; an app at rest draws no frames |
| A long turn with 40 tool calls | The fold: one muted line, paths and counts as links |
| A code block of 500 lines, a mermaid diagram, a 20 MB image | `code-block`, `mermaid-block`, `image-view` limits |

## Numbers and time

| Value | Breaks |
|---|---|
| 0, 1, 2 | Plurals (`1 agent`, `0 need you`: should the line show at all?) |
| 99, 100, 1,284 | Count width, separators |
| Just now, 59 s, 12 m, 3 h, 9 d | Relative-time steps, `Age` column width |
| A clock skewed into the future | Negative durations |
| `quiet 41m` growing to `1h` | A word that changes width every minute |

## Network and lifecycle

| Value | Breaks |
|---|---|
| Offline from launch | First paint labelled, nothing pretends to be live |
| ssh drops while an answer is sent | The text is kept, the failure says what and what next |
| A link that flaps every 10 s | A footer line or amber name that appears and vanishes: no flicker loop |
| A host key that changed | A hard stop, never a silent re-trust |
| Window hidden for 2 hours, then shown | The catch-up is not news: no notification storm, stale labels honest |
| A second question arriving while typing | The draft is kept; the dock never takes focus |

## Environment

| Condition | Breaks |
|---|---|
| 760 x 800 | The rail, one pane at a time, inspector dropped |
| 960 x 800 | Sidebar at `snug()`, the inspector overlaying |
| 2560 x 1440 | The conversation's measure, a second region for the surplus |
| `fontScale()` 2.0 | Fixed-height boxes; columns drop, rows grow |
| Dark and light, four themes | Hard-coded colour, invisible hairlines, `signal` contrast |
| Reduced motion | Nothing animates; dialogs still fade (nsh) |
| A screen reader (Orca) | One named node per control; the answer dock announced once, politely |
| Keyboard only | Tab order, `FOCUS_RING` visible, every popup left with `Escape` |
