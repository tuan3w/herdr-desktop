// The states of the app worth looking at, shared by the screenshots (`make shots`) and the AT-SPI audit (`make a11y`).
import type { App } from "nsh/test";

export interface Scenario {
  fixture: string;
  /** The entry to open, relative to `.shots/` (default the app): a lab for a screen that needs a folder of its own. */
  entry?: string;
  /** Launch parameters of the entry besides `fixture` (`host.params`): which part a lab shows. */
  params?: Record<string, unknown>;
  /** Brings the window to the state. */
  steps: (app: App) => Promise<void>;
  /** Runs after the screenshot or the audit: ends what the state started outside the window (a session's keeper). */
  cleanup?: (app: App) => Promise<void>;
}

const pressFirst = async (app: App, selector: string) => {
  await app.press(`${selector} >> nth=0`);
  await app.wait(800);
};

/** Presses a button of the files lab and gives the dialog it opens time to read its folder. */
const lab = async (app: App, button: string) => {
  await app.press(button);
  await app.wait(1000);
};

/** `Show terminal` when the tab is a chat read from a terminal agent's log; a pane that has no chat is already the terminal. */
const showTerminal = async (app: App) => {
  if (app.shows("Show terminal")) {
    await app.press("Show terminal");
    await app.wait(800);
  }
};

export const SCENARIOS: Record<string, Scenario> = {
  // The home: projects as cards (a repository with a linked worktree, two workspaces of one repository, a folder), each
  // agent in its project, and what needs you above them.
  board: { fixture: "projects", steps: async () => {} },
  // The same home with two projects of five and three agents each.
  projects: { fixture: "mixed", steps: async () => {} },
  // A press on a project of the sidebar: in the 760 rail its tile opens a popover with the project's agents, wider it folds the project.
  "project-press": { fixture: "projects", steps: (app) => pressFirst(app, "label:/^payments-api, This computer/") },
  storm: { fixture: "storm", steps: async () => {} },
  empty: { fixture: "empty", steps: async () => {} },
  // An agent with a chat opens as one (read from its log); `Show terminal` is the mirror of the same pane.
  "agent-chat": { fixture: "mixed", steps: (app) => pressFirst(app, "text:payments review") },
  // A terminal agent opens as its chat; `Show terminal` replaces the chat's whole view (list, composer, inputs) with the pane mirror.
  // On nsh 0.4.0's Linux host this once took the process down (see `docs/upstream/nsh-selectable-textview-in-list.md`), so the
  // button must exist here: the scenario fails when the fixture's agent stops having a chat.
  pane: {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:payments review");
      await app.press("Show terminal");
      await app.wait(800);
    },
  },
  // An omp pane whose log is not readable as a chat in the fixture: it opens as the mirror at once, there is no `Show terminal`.
  working: {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:Refactor ledger");
      await showTerminal(app);
    },
  },
  // The tab swap that destroys native widgets (a chat's composer and text, then the mirror's) and the tab close, twice over:
  // chat -> terminal -> chat -> terminal -> chat -> `mod+w`. A host that dies fails the next step ("the host left"); the shot is
  // the board that is left. Then a second agent's chat is opened and closed with the theme switched in between.
  "chat-swap": {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:payments review");
      for (let i = 0; i < 2; i++) {
        await app.press("Show terminal");
        await app.wait(500);
        await app.press("Show chat");
        await app.wait(500);
      }
      await app.keyboard.press("ctrl+w");
      await app.wait(600);
      await pressFirst(app, "text:payments review");
      await app.setColorScheme("dark");
      await app.wait(400);
      await app.setColorScheme("light");
      await app.setViewport(900, 700);
      await app.wait(400);
      await app.keyboard.press("ctrl+w");
      await app.wait(600);
    },
  },
  triage: { fixture: "projects", steps: (app) => pressFirst(app, "text:Answer one by one") },
  palette: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+k"); await app.wait(400); } },
  settings: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+,"); await app.wait(400); } },
  shortcuts: { fixture: "mixed", steps: async (app) => { await app.keyboard.press("F1"); await app.wait(400); } },
  "new-agent": { fixture: "mixed", steps: async (app) => { await app.keyboard.press("ctrl+n"); await app.wait(400); } },
  machines: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+k");
      await app.wait(300);
      await app.type("label:Search commands", "Machines");
      await app.keyboard.press("enter");
      await app.wait(400);
    },
  },
  // A watched pane first, so the pane-path figures have readings; the panel refreshes twice a second.
  "dev-panel": {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:Refactor ledger");
      await app.keyboard.press("ctrl+shift+d");
      await app.wait(1200);
    },
  },
  // Notifications on: the section's switches, with the second one enabled.
  "settings-notifications": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+,");
      await app.wait(400);
      await app.press("label:Notify me when an agent needs me");
      await app.wait(600);
    },
  },
  // A machine over ssh that cannot be reached (`.invalid` never resolves, so the real ssh fails at once and nothing is
  // contacted): its row says why and counts down to the next attempt. The attention states (changed or untrusted host
  // key) need scripted ssh output and are covered by `components/machines.test.tsx`.
  "machines-attention": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+k");
      await app.wait(300);
      await app.type("label:Search commands", "Machines");
      await app.keyboard.press("enter");
      await app.wait(600);
      await app.press("Add machine");
      await app.type("label:Name *", "Build box");
      await app.type("label:Destination *", "devbox.invalid");
      await app.press("Add");
      await app.wait(1200);
    },
  },
  // The file screens run in their lab (`components/files-lab.tsx`): a synthetic folder the test seam copies, opened by the lab's
  // buttons. The file browser, the read-only viewer on code and on Markdown with its diagram, the photo viewer, the send dialog.
  files: { fixture: "mixed", entry: "../components/files-lab.tsx", steps: (app) => lab(app, "Browse files") },
  "file-code": { fixture: "mixed", entry: "../components/files-lab.tsx", steps: (app) => lab(app, "View main.rs at line 12") },
  "file-diagram": { fixture: "mixed", entry: "../components/files-lab.tsx", steps: (app) => lab(app, "View the design notes") },
  "file-markdown": { fixture: "mixed", entry: "../components/files-lab.tsx", steps: (app) => lab(app, "View the readme") },
  photo: {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    steps: async (app) => {
      await app.press("Browse files");
      await app.wait(600);
      await app.press("label:/^assets, folder/");
      await app.wait(500);
      await app.press("label:/^shot-2\\.png, file/");
      await app.wait(1000);
    },
  },
  "send-files": { fixture: "mixed", entry: "../components/files-lab.tsx", steps: (app) => lab(app, "Send data.bin to docs") },
  // The chat's parts run in their lab (`components/chat-parts-lab.tsx`). The permission dock on a risky deploy script with
  // its edits and plan, armed after the first press; the form of a question; the New session dialog before and after a
  // failed start; Past sessions; the session's details.
  permission: { fixture: "empty", entry: "../components/chat-parts-lab.tsx", params: { part: "synthetic", variant: "full", quiet: true }, steps: (app) => app.wait(900) },
  "permission-armed": {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "synthetic", variant: "full", quiet: true },
    steps: async (app) => {
      await app.wait(900);
      await app.press("Allow once");
      await app.wait(300);
    },
  },
  question: { fixture: "empty", entry: "../components/chat-parts-lab.tsx", params: { part: "synthetic", variant: "question", quiet: true }, steps: (app) => app.wait(900) },
  "new-session": { fixture: "empty", entry: "../components/chat-parts-lab.tsx", params: { part: "new-session" }, steps: (app) => app.wait(1500) },
  "new-session-error": {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "new-session" },
    steps: async (app) => {
      await app.wait(1200);
      await app.type("label:Folder *", "/nonexistent-folder");
      await app.press("Start");
      await app.wait(1500);
    },
  },
  "past-sessions": { fixture: "empty", entry: "../components/chat-parts-lab.tsx", params: { part: "past", agent: "omp" }, steps: (app) => app.wait(1500) },
  "session-overview": {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "live", endAfter: 2500 },
    steps: async (app) => {
      await app.press("Start a session");
      await app.wait(1500);
      await app.press("Open details");
      await app.wait(800);
    },
    // The lab ends its session itself after the screenshot (the audit ends the run first: `endAfter` is the lab's own timer).
    cleanup: async (app) => {
      await app.keyboard.press("escape");
      await app.press("End all sessions");
    },
  },
  // The chat tab runs in its lab (`components/session-lab.tsx`, scripted scenes): a finished turn with its answer, a running turn
  // with calls open (a diff, a failed command, a subagent), the plan and the queue with the command list open, and a long chat.
  chat: { fixture: "empty", entry: "../components/session-lab.tsx", params: { mode: "scripted", scene: "chat", quiet: true }, steps: (app) => app.wait(900) },
  "chat-tools": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "tools", quiet: true },
    steps: async (app) => {
      await app.wait(700);
      await app.press("label:/^Worked, 1 command, 1 file changed, 1 failed/");
      await app.wait(300);
      await app.press("label:/^Tool: Edited src\\/auth\\.ts/");
      await app.wait(300);
      await app.press("label:/^Tool: Ran pnpm test, failed/");
      await app.wait(600);
    },
  },
  "chat-plan": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "plan", quiet: true },
    steps: async (app) => {
      await app.wait(700);
      await app.press("label:/^Plan, 1 of 3 done/");
      await app.type("label:Message", "/re");
      await app.wait(600);
    },
  },
  // An answer with code of every kind the chat meets: TypeScript, Rust, Python, shell, JSON, a diff, a long line, a block of 300
  // lines (folded), a fence with no language, one inside a list item, inline code. Scrolled so that each part is on screen.
  "chat-code": { fixture: "empty", entry: "../components/session-lab.tsx", params: { mode: "scripted", scene: "code", quiet: true }, steps: (app) => app.wait(1200) },
  // The same answer scrolled up a page at a time: `chat-code-1` is the top, the next two follow it down.
  ...Object.fromEntries(
    [1, 2, 3].map((n): [string, Scenario] => [
      `chat-code-${n}`,
      {
        fixture: "empty",
        entry: "../components/session-lab.tsx",
        params: { mode: "scripted", scene: "code", quiet: true },
        steps: async (app) => {
          await app.wait(1000);
          for (let i = 0; i < 6 - (n - 1) * 1; i++) {
            await app.keyboard.press("pageup");
            await app.wait(150);
          }
          for (let i = 0; i < n - 1; i++) {
            await app.keyboard.press("pagedown");
            await app.wait(150);
          }
          await app.wait(500);
        },
      },
    ]),
  ),
  // The same message while a reply is being written: an open fence, half of it on screen.
  "chat-code-stream": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "code-stream", quiet: true, autostream: 40, upTo: 6 },
    steps: (app) => app.wait(1200),
  },
  "chat-long": { fixture: "empty", entry: "../components/session-lab.tsx", params: { mode: "scripted", scene: "long", quiet: true }, steps: (app) => app.wait(1200) },
  // An agent that refuses the session until a sign-in: the card in place of the conversation, with a refusal under the buttons.
  "chat-signin": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "signin", quiet: true },
    steps: async (app) => {
      await app.wait(700);
      await app.press("I did it, try again");
      await app.wait(600);
    },
  },
};

// The code labs (`components/code-lab.tsx`; `docs/specs/chat-craft.md`, "Code"). Synthetic samples in every language, a fence
// that is still being written, diffs, a block of 3,000 lines, and nsh's own code views beside ours.
const code = (params: Record<string, unknown>, steps: Scenario["steps"] = (app) => app.wait(900)): Scenario => ({
  fixture: "empty",
  entry: "../code-lab-app.tsx",
  params,
  steps,
});
export const CODE_SCENARIOS: Record<string, Scenario> = {
  "code-one-ts": code({ part: "one", lang: "ts", numbers: true }),
  "code-one-tsx": code({ part: "one", lang: "tsx" }),
  "code-one-rust": code({ part: "one", lang: "rust" }),
  "code-one-python": code({ part: "one", lang: "python" }),
  "code-one-go": code({ part: "one", lang: "go" }),
  "code-one-bash": code({ part: "one", lang: "bash" }),
  "code-one-sql": code({ part: "one", lang: "sql" }),
  "code-one-yaml": code({ part: "one", lang: "yaml" }),
  "code-one-html": code({ part: "one", lang: "html" }),
  "code-one-markdown": code({ part: "one", lang: "markdown" }),
  "code-one-css": code({ part: "one", lang: "css" }),
  "code-languages": code({ part: "languages", from: 0, count: 6, fold: 7 }),
  "code-stream": code({ part: "stream", lang: "ts", chunk: 9 }, (app) => app.wait(1100)),
  "code-diff": code({ part: "diff" }),
  "code-diff-split": code({ part: "diff", layout: "split" }),
  "code-patch": code({ part: "patch" }),
  "code-long": code({ part: "long", lines: 3000 }, (app) => app.wait(1500)),
  "code-compare-ts": code({ part: "compare", lang: "ts" }, (app) => app.wait(3000)),
  "code-compare-rust": code({ part: "compare", lang: "rust" }, (app) => app.wait(3000)),
  "code-host-diff": code({ part: "host-diff" }, (app) => app.wait(3000)),
  "code-inline": code({ part: "inline" }),
};
Object.assign(SCENARIOS, CODE_SCENARIOS);
