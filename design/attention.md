# Attention

Attention is what the app exists for, and the way to protect it is to spend it rarely. An agent that waits is said once per view, in one place, loudly; everywhere else the same fact is a quiet shape and a word. A screen where ten agents wait must read as calm: the person sees where to go, not ten alarms.

The one hot colour is `signal` (`design/colors.md`). Everything below is about where it may appear.

## The rules

1. **Once per agent per view.** In one window an agent that needs the person has at most one signal-coloured mark. The `Needs you` inbox owns it (`StatusGlyph loud`: the filled disc with a bar, 16 pt). Its row in the sidebar, its row on its project's card, its tab, the status bar, the header of its own pane or chat say it in the muted ink: a small shape (`StatusGlyph`, quiet), the words `waiting for you` (`stateWord`) and, in the title bar and status bar, a plain count.
2. **A handful per viewport.** Signal colour appears only as (a) the loud disc of an agent in the inbox, at most `STRIP_SHOWN` of them, and (b) one 8-pt dot per project on each surface that lists projects (sidebar row, card header, rail tile): `Badge dot tone="signal"` through `ProjectMark`. Ten waiting agents in three projects are one disc and three dots in the sidebar and three on the cards; twenty in five projects are one disc and ten dots, never twenty marks.
3. **A project says it once.** `ProjectMark` is the project's whole aggregate: the dot when something waits, and muted words (`2 waiting · 2 working · 1 to review` on a card, `2` in the sidebar, `2 working` when nothing waits). Never a chip per state, never a capsule, never a half ring and a check beside a count.
4. **Shape first, thin and muted.** The five shapes stay (needs you = filled with a bar, working = half ring, done = check, idle = ring, unknown = dashed ring), small (12 pt) and in `muted-foreground`; idle and unknown at 60% opacity. Colour was never the signal and now it is not even the distinction between working and done: the shape and the words are.
5. **The inbox is the only place with the question.** A waiting row on a card has no chips and no dock: it says `waiting for you` in its meta line and has `Answer` (a ghost button) that opens `Triage` at that agent, or the chat tab for a chat. The sidebar row has nothing to press but the row. The question is therefore shown once per view, in the inbox; the next agent to wait longest takes its place when it is answered.
6. **A crowd is a sentence.** The inbox answers one agent in place. The others are one muted line grouped by project (`19 more waiting · docs 4 · infra 4 · payments-api 4`, `strip().moreIn`) and `Answer one by one` walks them. Never a list of twenty.
7. **Orange text is rare.** No text is `text-signal`: not the status line, not the inbox heading, not the status bar. A count is a number in `foreground` or `muted-foreground`. The exception is the chat's `New output` pill while the agent waits (it is the single mark of that agent in a chat that scrolled away from its dock).
8. **Risk is a shape, not a colour.** The `alert` icon on a risky answer chip is muted; the amber `warning` colour appears only when the chip is armed (`Press again to send`), the one moment the colour is an instruction.
9. **The window title and the tray count stay.** `Window.setTitle` shows `(N) Herdr Desktop`; it is the one count seen from another window.

## What each surface shows

| Surface | The agent that waits | The project / total |
|---|---|---|
| inbox (`NeedsYou`) | loud disc, name, project, the one `AnswerDock`, `Reply…` | `Needs you` with a muted count; the rest as a grouped sentence |
| sidebar row (`Agent`) | quiet filled disc, `waiting for you · claude` | the project row: dot and number |
| card row (`AgentRow`) | quiet filled disc, `waiting for you · claude · terminal`, `Answer` | the card header: dot and `2 waiting · …` |
| rail tile | nothing of the agent | one dot in the corner of the tile |
| tab | quiet disc beside the name | none |
| status bar | none | `2 need you` in `foreground` |
| home status line | none | `2 need you · 1 to review · …` in the muted ink |
| pane or chat header | quiet disc and the word `Needs you` in `foreground` | none |

## Before and after

The `projects` screen at 1280 (two agents wait in one project) and the `storm` screen (twenty in five), counted from the screenshots and the code (`.shots/`, `StatusGlyph`, `Badge`, `text-signal`):

| Screen | Marks before | Marks after |
|---|---|---|
| `projects` | 14 signal-coloured marks in view: the status line count, the Board capsule, in the sidebar the project's disc and capsule and two row discs, the inbox heading text, its heading disc and its row disc, on the card the disc and the capsule and two row discs, the status bar count | 3: the inbox disc, the sidebar project dot, the card dot |
| `storm` | about 31 in the first view (every row disc and a disc plus capsule per project, in the sidebar and on the cards, the inbox and the two counts) and 20 row discs, 10 project capsules and 2 counts in all | 6 in the first view and 11 in all: the inbox disc and one dot per project, in the sidebar and on its card |

## How the code enforces it

- `StatusGlyph` is quiet unless `loud` is passed, and only `NeedsYou` and `Triage` pass it.
- `ProjectMark` is the only component that draws a project's state; the per-state chips and the signal capsule no longer exist.
- `text-signal` is used by nothing but the chat pill (`session-transcript.tsx`); a new use is a design change (edit this file).
- `Question` (the chips) is rendered by the inbox only; `AgentRow` has `Answer`.
- `components/board.test.tsx` pins the count of answer chips on the home to one set and the count of `Answer` buttons to the agents that wait.

## Accessibility

States are still exposed as words and roles, never colour alone: every row's accessible name says `needs you` (`rowLabel`), a project's group says `2 need you, 1 working` (`projectLabel`), the sidebar announces changes of the count politely (`announceNeedsYou`), and a chat's header is a live alert while the agent waits. The quiet shapes are decorative and hidden from assistive technology; the words beside them carry the state.
