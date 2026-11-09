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

const PALETTE_FIELD = "label:Search agents, projects and commands";

const pressFirst = async (app: App, selector: string) => {
  await app.press(`${selector} >> nth=0`);
  await app.wait(800);
};

/** Presses a button of the files lab and gives the dialog it opens time to read its folder. */
const lab = async (app: App, button: string) => {
  await app.press(button);
  await app.wait(1000);
};

/** `Terminal` when the tab is a chat read from a terminal agent's log; a pane that has no chat is already the terminal. */
const showTerminal = async (app: App) => {
  if (app.shows("label:Show terminal")) {
    await app.press("label:Show terminal");
    await app.wait(800);
  }
};

export const SCENARIOS: Record<string, Scenario> = {
  // Throwaway: the terminal's font size and leading drawn as rows of text (`components/terminal-proto-lab.tsx`); `--fixture A..E|compare`.
  "terminal-proto": { fixture: "A", entry: "../components/terminal-proto-lab.tsx", steps: async () => {} },
  // The native terminal (`components/terminal-lab.tsx`) running synthetic programs from `.scratch/term/` (run from the repo root):
  // a fake agent TUI (box drawing, truecolor, a bar, a diff), `vim -u NONE -N` with the mouse on, and a long coloured listing.
  "terminal-tui": {
    fixture: "mixed",
    entry: "../components/terminal-lab.tsx",
    params: { command: "python3 -I .scratch/term/tui.py" },
    steps: async (app) => app.wait(1500),
  },
  "terminal-vim": {
    fixture: "mixed",
    entry: "../components/terminal-lab.tsx",
    params: { command: "vim -u NONE -N -c 'syntax on' -c 'set mouse=a number' .scratch/term/vim.txt" },
    steps: async (app) => app.wait(1500),
  },
  "terminal-ls": {
    fixture: "mixed",
    entry: "../components/terminal-lab.tsx",
    params: { command: "cat .scratch/term/ls.txt; sleep 60" },
    steps: async (app) => app.wait(1500),
  },
  // The terminal tab of a terminal agent: `Terminal` pressed on its chat, the synthetic fake agent TUI as the program (`Herdr.testSetProgram`;
  // a test run never starts the herdr client).
  "terminal-tab": {
    fixture: "mixed",
    steps: async (app) => {
      const { Herdr } = await import("herdr-desktop/native");
      Herdr.testSetProgram("python3 -I .scratch/term/tui.py");
      await pressFirst(app, "text:payments review");
      await app.press("label:Show terminal");
      await app.wait(1800);
    },
  },
  // A pane herdr could not restore after a restart: herdr's reason stands where the terminal would be, with `Close pane`.
  "pane-not-running": {
    fixture: "unrestored",
    steps: async (app) => {
      await pressFirst(app, "text:payments review");
      await app.wait(1200);
    },
  },
  // The expanded sidebar at a width the person dragged it to (`host.params.sidebarWidth`; `--size` sets the window), over the
  // worktrees fixture whose names are long: the Board is in front, so the fold toggle opens the full sidebar for the shot.
  ...Object.fromEntries(
    [240, 264, 340, 420].map((w) => [
      `sidebar-${w}`,
      {
        fixture: "worktrees",
        params: { sidebarWidth: w },
        steps: async (app: App) => {
          await app.keyboard.press("mod+b");
          await app.wait(800);
        },
      } satisfies Scenario,
    ]),
  ),
  // The home: projects as cards (a repository with a linked worktree, two workspaces of one repository, a folder), each
  // agent in its project, and what needs you above them.
  board: { fixture: "projects", steps: async () => {} },
  // The same home with two projects of five and three agents each.
  projects: { fixture: "mixed", steps: async () => {} },
  // A press on a project of the sidebar: in the 760 rail its tile opens a popover with the project's agents, wider it folds the project.
  "project-press": { fixture: "projects", steps: (app) => pressFirst(app, "label:/^payments-api, This computer/") },
  storm: { fixture: "storm", steps: async () => {} },
  empty: { fixture: "empty", steps: async () => {} },
  // An agent with a chat opens as one (read from its log); `Terminal` opens the real terminal of the same pane (the test program, never herdr).
  "agent-chat": { fixture: "mixed", steps: (app) => pressFirst(app, "text:payments review") },
  // A terminal agent opens as its chat; `Terminal` replaces the chat's whole view (list, composer, inputs) with the terminal.
  // On nsh 0.4.0's Linux host this once took the process down (see `docs/upstream/nsh-selectable-textview-in-list.md`), so the
  // button must exist here: the scenario fails when the fixture's agent stops having a chat.
  pane: {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:payments review");
      await app.press("label:Show terminal");
      await app.wait(800);
    },
  },
  // An omp pane whose log is not readable as a chat in the fixture: it opens as the terminal at once, there is no `Terminal` button.
  working: {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:Refactor ledger");
      await showTerminal(app);
    },
  },
  // The tab swap that destroys native widgets (a chat's composer and text, then the terminal's) and the tab close, twice over:
  // chat -> terminal -> chat -> terminal -> chat -> `mod+w`. A host that dies fails the next step ("the host left"); the shot is
  // the board that is left. Then a second agent's chat is opened and closed with the theme switched in between.
  "chat-swap": {
    fixture: "mixed",
    steps: async (app) => {
      await pressFirst(app, "text:payments review");
      for (let i = 0; i < 2; i++) {
        await app.press("label:Show terminal");
        await app.wait(500);
        await app.press("label:Show chat");
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
  // Two agents of `payments` and then the next project were opened by keys (the rail of a narrow window has no names to
  // press), then `mod+e`: the places visited, the one to go back to highlighted.
  switcher: {
    fixture: "mixed",
    steps: async (app) => {
      for (const keys of ["ctrl+j", "ctrl+j", "ctrl+shift+]", "ctrl+e"]) {
        await app.keyboard.press(keys);
        await app.wait(600);
      }
    },
  },
  // A project switch: two agents open in `payments`, then the next project (`web`, nothing open: its own card).
  "context-switch": {
    fixture: "mixed",
    steps: async (app) => {
      for (const keys of ["ctrl+j", "ctrl+j", "ctrl+shift+]"]) {
        await app.keyboard.press(keys);
        await app.wait(600);
      }
    },
  },
  // The command palette (`design/palette.md`): empty (what needs you, what was visited, suggestions), a query, a scope, the
  // actions of a row, a two-step command, the empty app, nothing found, and the files of a project (in the palette lab).
  palette: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(500);
    },
  },
  "palette-query": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type(PALETTE_FIELD, "pay");
      await app.wait(400);
    },
  },
  "palette-agents": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type(PALETTE_FIELD, "@");
      await app.wait(400);
    },
  },
  "palette-actions": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type(PALETTE_FIELD, "auth");
      await app.wait(300);
      await app.keyboard.press("ctrl+p");
      await app.wait(400);
    },
  },
  "palette-two-step": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type(PALETTE_FIELD, "new session pay");
      await app.wait(500);
    },
  },
  "palette-empty": {
    fixture: "empty",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(500);
    },
  },
  "palette-noresult": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type(PALETTE_FIELD, "zzzqq");
      await app.wait(500);
    },
  },
  "palette-files": {
    fixture: "mixed",
    entry: "../components/palette-lab.tsx",
    steps: async (app) => {
      await app.press("Find a file");
      await app.wait(1200);
      await app.type("label:Search files of this project", "read");
      await app.wait(600);
    },
  },
  settings: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+,");
      await app.wait(400);
    },
  },
  // Settings scrolled to the code options of Look (Wrap code, Line numbers in code, Show tabs and spaces, Diffs side by side).
  "settings-code": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+,");
      await app.wait(400);
      await app.scroll("text:Minimum contrast", 330);
      await app.wait(300);
    },
  },
  shortcuts: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("F1");
      await app.wait(400);
    },
  },
  "new-agent": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+n");
      await app.wait(400);
    },
  },
  machines: {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type("label:Search agents, projects and commands", "Machines");
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
      await app.press("label:Notifications");
      await app.wait(300);
      await app.press("label:Notify me when an agent needs me");
      await app.wait(600);
    },
  },
  // Storage: what the app keeps on this computer, the switch that keeps it, and Clear.
  "settings-storage": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+,");
      await app.wait(400);
      await app.press("label:Storage");
      await app.wait(300);
    },
  },
  // A machine over ssh that cannot be reached (`.invalid` never resolves, so the real ssh fails at once and nothing is
  // contacted): its row says why and counts down to the next attempt. The attention states (changed or untrusted host
  // key) need scripted ssh output and are covered by `components/machines.test.tsx`.
  "machines-attention": {
    fixture: "mixed",
    steps: async (app) => {
      await app.keyboard.press("ctrl+p");
      await app.wait(300);
      await app.type("label:Search agents, projects and commands", "Machines");
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
  // The Files tab opened on start (a Mac screenshot cannot press the lab's buttons): the docs folder, so the path has depth.
  "files-tab": {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    params: { open: "docs" },
    steps: async () => {},
  },
  "file-code": {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    steps: (app) => lab(app, "View main.rs at line 12"),
  },
  "file-diagram": {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    steps: (app) => lab(app, "View the design notes"),
  },
  "file-markdown": {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    steps: (app) => lab(app, "View the readme"),
  },
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
  "send-files": {
    fixture: "mixed",
    entry: "../components/files-lab.tsx",
    steps: (app) => lab(app, "Send data.bin to docs"),
  },
  // The message box's popups (`components/composer-picker.tsx`) in the scripted chat of `components/session-lab.tsx`. Each types into the
  // box and gives the 150 ms bubble time to show; `--js` / `--keys down` moves the highlight for a second picture of the same list.
  "composer-slash": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "many-commands", quiet: true },
    steps: async (app) => {
      await app.type("label:Message", "/");
      await app.wait(700);
    },
  },
  // A person's message with pictures in a chat read from a log: thumbnails in place of `[Image #n]`, a too-large tile and a gone one.
  "turn-pictures": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "pictures", quiet: true },
    steps: async (app) => {
      await app.waitFor("label:Open picture");
      await app.wait(300);
    },
  },
  "composer-file": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "chat", quiet: true },
    steps: async (app) => {
      await app.type("label:Message", "@");
      await app.wait(1200);
    },
  },
  // The `+` menu is a native NSMenu on a Mac and does not show in the screenshot: the scenario opens it for Linux (`make shots`).
  "composer-plus": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "chat", quiet: true },
    steps: async (app) => {
      await app.press("label:Attach");
      await app.wait(800);
    },
  },
  // Not quiet: the lab prints the synthetic folder the pictures are read from (`Tree: ...`).
  "composer-photo": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "chat", quiet: false },
    steps: async (app) => {
      const tree = (app.texts().find((t) => t.startsWith("Tree: ")) ?? "Tree: ").slice("Tree: ".length);
      await app.paste("label:Message", { files: [`${tree}/assets/shot-1.png`] });
      await app.paste("label:Message", { files: [`${tree}/assets/shot-2.png`] });
      await app.wait(1200);
    },
  },
  // The chat's parts run in their lab (`components/chat-parts-lab.tsx`). The permission dock on a risky deploy script with
  // its edits and plan, armed after the first press; the form of a question; the New session dialog before and after a
  // failed start; Past sessions; the session's details.
  permission: {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "synthetic", variant: "full", quiet: true },
    steps: (app) => app.wait(900),
  },
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
  question: {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "synthetic", variant: "question", quiet: true },
    steps: (app) => app.wait(900),
  },
  "new-session": {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "new-session" },
    steps: (app) => app.wait(1500),
  },
  // The path field's suggestions: focused, the list open under it (`Tab` completes a folder). One dialog, never two.
  "new-session-folder": {
    fixture: "mixed",
    entry: "../components/new-session-folder-lab.tsx",
    // The form opens on the synthetic folder with its slash: Down lists its folders under the field.
    params: { start: "~tree/" },
    steps: async (app) => {
      await app.wait(1200);
      await app.keyboard.press("down");
      await app.wait(1200);
    },
  },
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
  "past-sessions": {
    fixture: "empty",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "past", agent: "omp" },
    steps: (app) => app.wait(1500),
  },
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
  chat: {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "chat", quiet: true },
    steps: (app) => app.wait(900),
  },
  "chat-tools": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "tools", quiet: true },
    steps: async (app) => {
      await app.wait(700);
      await app.press("label:/^Read 1 file, ran 1 command, edited 1 file/");
      await app.wait(300);
      await app.press("label:/^Tool: Edited src\\/auth\\.ts/");
      await app.wait(300);
      await app.press("label:/^Tool: Ran pnpm test, failed/");
      await app.wait(600);
    },
  },
  // A Claude Code session opened up: runs of calls with the agent's narration between them (the three groups differ in their counts).
  "chat-calls": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "calls-narration", quiet: true },
    steps: async (app) => {
      await app.wait(700);
      for (const label of [
        "Read 1 file, ran 5 commands, edited 1 file",
        "Ran 5 commands, edited 1 file",
        "Read 1 file, ran 4 commands, edited 1 file",
      ]) {
        await app.press(`label:/^${label}/`);
        await app.wait(300);
      }
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
  "chat-code": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "code", quiet: true },
    steps: (app) => app.wait(1200),
  },
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
  // A turn this window watched start, a call running for about 4 s: the live line with its clock (`Running … · 4s`).
  "chat-working": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "working", quiet: true },
    steps: (app) => app.wait(4500),
  },
  // The same with a command longer than the column (owner, 2026-11-09: the live line ran past the conversation's edge).
  "chat-working-long": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: {
      mode: "scripted",
      scene: "working",
      quiet: true,
      command:
        "for i in 1 2 3; do curl -sS -o /dev/null -w '%{http_code} %{url_effective}\\n' -L https://github.com/acme/payments-api/releases/download/v0.1.0/SHA256SUMS; done",
    },
    steps: (app) => app.wait(4500),
  },
  // omp's `task` call with three subagents, two working and one done: a line each under the card's header, in view.
  "chat-subagents": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "subagents", quiet: true },
    steps: (app) => app.wait(3000),
  },
  // The same once all three are done: the lines fold behind the chevron and the header says `3 subagents, 2m 10s`.
  "chat-subagents-done": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "subagents-done", quiet: true },
    steps: (app) => app.wait(3000),
  },
  // Failures the agent got past are a count and a muted `Retried` (the fold opened to show the rows); one that stands is a line.
  "chat-retried": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "retried", quiet: true },
    steps: async (app) => {
      await app.wait(2500);
      await app.press("label:/retried$/ >> nth=0");
      await app.wait(600);
    },
  },
  // A chat read from a terminal agent while it works: no queue, the box says where a message goes.
  "chat-terminal-working": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "terminal", quiet: true },
    steps: (app) => app.wait(3000),
  },
  // The details of an agent seen in a herdr pane: they name its workspace and tab (the popover's scroll gutter is here too).
  "session-overview-pane": {
    fixture: "mixed",
    entry: "../components/chat-parts-lab.tsx",
    params: { part: "pane-chat" },
    steps: (app) => app.wait(1500),
  },
  // A name that can be taken away: the pane's label, empty is allowed and the helper says what it means.
  "rename-pane": {
    fixture: "mixed",
    entry: "../components/machines-lab.tsx",
    steps: async (app) => {
      await app.press("Rename pane label");
      await app.wait(600);
    },
  },
  // The person's message with a picture and a file attached, and tool rows naming relative paths (`attached` scene).
  "chat-attached": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "attached", quiet: true },
    steps: (app) => app.wait(3000),
  },
  // The top of that answer with the pointer over its first block (the tools show), after `Copy code`, and with line numbers and
  // wrapping switched on from the tools.
  ...Object.fromEntries(
    (["hover", "copied", "options"] as const).map((name): [string, Scenario] => [
      `chat-code-${name}`,
      {
        fixture: "empty",
        entry: "../components/session-lab.tsx",
        params: { mode: "scripted", scene: "code", quiet: true },
        steps: async (app) => {
          await app.wait(1000);
          for (let i = 0; i < 6; i++) {
            await app.keyboard.press("pageup");
            await app.wait(150);
          }
          await app.wait(400);
          if (name === "options") {
            await app.press("label:Line numbers >> nth=0");
            await app.press("label:Wrap lines >> nth=0");
          }
          await app.hover("label:/^Code, TypeScript/");
          if (name === "copied") await app.press("label:Copy code >> nth=0");
          await app.wait(500);
        },
      },
    ]),
  ),
  "chat-long": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "long", quiet: true },
    steps: (app) => app.wait(1200),
  },
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
  // Links and pictures in an agent's words (the `links` scene, synthetic): thumbnails, chips, short links; then the side
  // panel on a picture, on a file at its line, and on a web page in the browser (on a host without network it shows its
  // failure); `page-address` with the address field taking the keyboard, `page-failed` on a reserved `.invalid` host that
  // never resolves (never a localhost port, where a real dev server of this computer may answer), so the browser says
  // what happened.
  "chat-links": {
    fixture: "empty",
    entry: "../components/session-lab.tsx",
    params: { mode: "scripted", scene: "links", quiet: true },
    steps: (app) => app.wait(900),
  },
  ...Object.fromEntries(
    (
      [
        ["picture", "label:/^Picture shot-1\\.png/"],
        ["file", "text:src/main.rs:12"],
        ["page", "text:https://github.com/acme/payments-api/pull/128 >> nth=0"],
        ["page-address", "text:https://github.com/acme/payments-api/pull/128 >> nth=0"],
        ["page-failed", "text:https://github.com/acme/payments-api/pull/128 >> nth=0"],
      ] as const
    ).map(([name, link]): [string, Scenario] => [
      `chat-links-${name}`,
      {
        fixture: "empty",
        entry: "../components/session-lab.tsx",
        params: { mode: "scripted", scene: "links", quiet: true },
        steps: async (app) => {
          await app.waitFor(link);
          await app.press(link);
          await app.wait(name.startsWith("page") ? 3000 : 900);
          if (name === "page-address") {
            // `mod+L` is the browser's while the pointer is over it.
            await app.hover("label:Opened link");
            await app.keyboard.press("mod+l");
            await app.wait(300);
          }
          if (name === "page-failed") {
            await app.clear("label:Address");
            await app.type("label:Address", "herdr-desktop.invalid");
            await app.submit("label:Address");
            await app.wait(2000);
          }
        },
      },
    ]),
  ),
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

// The Changes tab on a synthetic repository the lab builds (`Git.testRepo`): every kind of change, a note kept and one being
// written, a clean checkout, and 522 changed files.
const changes = (params: Record<string, unknown>, steps: (app: App) => Promise<void> = async () => {}): Scenario => ({
  fixture: "mixed",
  entry: "../components/changes-lab.tsx",
  params,
  steps: async (app) => {
    await app.waitFor(params.kind === "clean" ? "No changes" : "label:Changed files", { timeout: 15000 });
    await app.wait(500);
    await steps(app);
    await app.wait(400);
  },
});
const openAuth = async (app: App) => {
  await app.press("label:/^src\\/auth\\.ts, /");
  await app.wait(600);
};
export const CHANGES_SCENARIOS: Record<string, Scenario> = {
  changes: { ...changes({}, openAuth) },
  "changes-split": {
    ...changes({}, async (app) => {
      await openAuth(app);
      await app.press("label:Side by side");
      await app.wait(600);
    }),
  },
  "changes-notes": {
    ...changes({}, async (app) => {
      await openAuth(app);
      await app.press("label:Next change");
      await app.press("Add note");
      await app.type("label:/^Note on change 1/", "Name this limit instead of repeating 5.");
      await app.submit("label:/^Note on change 1/");
      await app.wait(300);
      await app.press("label:Next change");
      await app.press("Add note");
      await app.type("label:/^Note on change 2/", "Why a minute?");
    }),
  },
  "changes-empty": { ...changes({ kind: "clean" }) },
  "changes-many": { ...changes({ kind: "many" }) },
};
// Changes opened from a chat's `Edited 7 files` on the `review` repository (seven files among 62 of the run's output), in a
// pane `width` points wide (the lab gives the tab that width, as it is beside a chat). `everything` shows the other scope,
// `sheet` opens the files from the bar of a narrow pane.
const EDITED = [
  "src/api/handler.ts",
  "src/api/router.ts",
  "src/lib/cache.ts",
  "src/lib/retry.ts",
  "src/lib/clock.ts",
  "src/legacy/compat.ts",
  "src/api/schema.ts",
];
const review = (width: number, steps: (app: App) => Promise<void> = async () => {}): Scenario => ({
  fixture: "mixed",
  entry: "../components/changes-lab.tsx",
  params: { kind: "review", edited: EDITED, width },
  steps: async (app) => {
    await app.waitFor(width >= 900 ? "label:Changed files" : "label:Next file", { timeout: 15000 });
    await app.wait(800);
    await steps(app);
    await app.wait(400);
  },
});
for (const w of [480, 640, 760, 900, 1100, 1400]) CHANGES_SCENARIOS[`changes-review-${w}`] = review(w);
// A presses by label does not land in the AppKit host, so these use keys: `f` opens the files of a narrow pane, `j` steps.
CHANGES_SCENARIOS["changes-review-sheet"] = review(640, async (app) => {
  await app.keyboard.press("f");
  await app.wait(800);
});
// Opened from the sidebar: no session, everything git reports, the output folded.
const everything = (steps: (app: App) => Promise<void> = async () => {}): Scenario => ({
  ...review(1100, steps),
  params: { kind: "review", width: 1100 },
});
CHANGES_SCENARIOS["changes-review-all"] = everything();
// A session whose only file is the 40,000-line dump: it opens on the summary, not on a diff.
CHANGES_SCENARIOS["changes-review-dump"] = {
  ...review(1100),
  params: { kind: "review", width: 1100, edited: ["data/dump/events.json"] },
};
CHANGES_SCENARIOS["changes-review-marked"] = review(760, async (app) => {
  await app.keyboard.press("x");
  await app.keyboard.press("x");
  await app.wait(600);
});
Object.assign(SCENARIOS, CHANGES_SCENARIOS);

// The tab bar (`design/tabs.md`): one project of twenty agents with long names, each opened as a tab by `mod+j` (the next
// agent that needs you; all of them wait in this fixture). Two tabs, nine and twenty. (A scenario that hovers a tab stops the AT-SPI audit finding the app, so the hover is only in `components/tabs.test.tsx`.)
const tabs = (count: number): Scenario => ({
  fixture: "tabs",
  steps: async (app) => {
    for (let i = 0; i < count; i++) {
      await app.keyboard.press("ctrl+j");
      await app.wait(250);
    }
    await app.wait(500);
  },
});
export const TAB_SCENARIOS: Record<string, Scenario> = {
  "tabs-few": { ...tabs(2) },
  "tabs-many": { ...tabs(9) },
  "tabs-twenty": { ...tabs(20) },
  // The glance test of the tab signs on the fixture whose agents differ in state: waiting, finished and not reviewed,
  // working, all in one project (a project has its own strip).
  "tabs-mixed": {
    fixture: "mixed",
    steps: async (app) => {
      for (const name of ["payments review", "auth", "Fix login flow", "Refactor ledger", "upgrade deps"]) {
        await pressFirst(app, `text:${name}`);
      }
      await app.wait(500);
    },
  },
};
Object.assign(SCENARIOS, TAB_SCENARIOS);

// The chat's message box in the session lab (`components/session-lab.tsx`, scripted port over a synthetic project): empty and
// focused, the `@` list over the caret, pictures and a file as chips, the `/` list, a long paste and many lines, and an agent
// that cannot see the pictures. The pictures are the fixture project's own.
const COMPOSER_BOX = "label:Message";
const SHOT = (n: number) => `fixtures/files/project/assets/shot-${n}.png`;
const composer = (scene: string, steps: (app: App) => Promise<void>, quiet = true): Scenario => ({
  fixture: "empty",
  entry: "../components/session-lab.tsx",
  params: { mode: "scripted", scene, quiet },
  steps: async (app) => {
    await app.wait(900);
    await steps(app);
    await app.wait(500);
  },
});
export const COMPOSER_SCENARIOS: Record<string, Scenario> = {
  composer: {
    ...composer("blank", async (app) => {
      await app.type(COMPOSER_BOX, "");
    }),
  },
  "composer-mention": {
    ...composer("blank", async (app) => {
      await app.type(COMPOSER_BOX, "compare the tests with @s");
      await app.wait(900);
      await app.keyboard.press("down");
      await app.wait(500);
    }),
  },
  // A text file highlighted (notes.txt, the 7th row): the preview with code lines, level with the list.
  "composer-mention-text": {
    ...composer("blank", async (app) => {
      await app.type(COMPOSER_BOX, "compare the tests with @s");
      await app.wait(900);
      for (let i = 0; i < 6; i++) await app.keyboard.press("down");
      await app.wait(700);
    }),
  },
  // One match: the list is a single row, so the preview keeps the list's bottom edge and grows upward (`PEEK_MIN`).
  "composer-mention-one": {
    ...composer("blank", async (app) => {
      await app.type(COMPOSER_BOX, "see @notes");
      await app.wait(1100);
    }),
  },
  "composer-images": {
    ...composer("blank", async (app) => {
      await app.type(COMPOSER_BOX, "why does this fail, see @notes");
      await app.wait(700);
      await app.keyboard.press("tab");
      await app.paste(COMPOSER_BOX, { files: [SHOT(1)] });
      await app.paste(COMPOSER_BOX, { files: [SHOT(2)] });
      await app.paste(COMPOSER_BOX, { files: [SHOT(3)] });
      await app.wait(900);
    }),
  },
  "composer-slash": {
    ...composer("commands", async (app) => {
      await app.type(COMPOSER_BOX, "/re");
      await app.wait(700);
    }),
  },
  "composer-long": {
    ...composer("blank", async (app) => {
      await app.paste(COMPOSER_BOX, {
        text: `${"2026-11-07 12:00:01 INFO request handled in 12 ms\n".repeat(400)}done`,
      });
      await app.type(COMPOSER_BOX, " what stands out in this log?");
      await app.wait(600);
    }),
  },
  "composer-error": {
    ...composer("blind", async (app) => {
      await app.paste(COMPOSER_BOX, { files: [SHOT(1)] });
      await app.paste(COMPOSER_BOX, { files: [SHOT(2)] });
      await app.wait(900);
    }),
  },
};
// Untouched boxes for `scripts/composer_keys.py`, which types into them with real X key events.
export const COMPOSER_LIVE_SCENARIOS: Record<string, Scenario> = {
  "composer-live": { ...composer("blank", async () => {}, false) },
  "composer-live-blind": { ...composer("blind", async () => {}, false) },
};
Object.assign(SCENARIOS, COMPOSER_SCENARIOS, COMPOSER_LIVE_SCENARIOS);

// The media and file viewers in their lab (`components/media-lab.tsx`): the player on a generated Theora clip and Vorbis song
// (waiting on the poster), the H.265 clip that this box cannot play, a picture, a PDF, a binary, an archive. A clip is given
// time to show its first frame; the PDF to load the web view.
const MEDIA = "../components/media-lab.tsx";
const viewer = (button: string, wait = 1500): Scenario => ({
  fixture: "mixed",
  entry: MEDIA,
  steps: async (app) => {
    await app.press(button);
    await app.wait(wait);
  },
});
export const MEDIA_SCENARIOS: Record<string, Scenario> = {
  "files-video": { ...viewer("Play clip.ogv", 2500) },
  "files-audio": { ...viewer("Play song.ogg", 2000) },
  "files-hevc": { ...viewer("Play hevc.mp4", 2500) },
  "files-image": { ...viewer("View shot-2.png") },
  "files-pdf": { ...viewer("View report.pdf", 4000) },
  "files-binary": { ...viewer("View tool.bin") },
  "files-archive": { ...viewer("View bundle.zip") },
};
Object.assign(SCENARIOS, MEDIA_SCENARIOS);

// THROWAWAY (herdr-prototype, layout question: split / inspector / wall): `components/layout-proto-lab.tsx`, stand-ins and
// invented content. Delete with the lab once the owner chooses.
const LAYOUT_PROTO = "../components/layout-proto-lab.tsx";
for (const v of ["baseline", "baseline-changes", "s", "i", "i-subagents", "w", "c"]) {
  SCENARIOS[`layout-proto-${v}`] = { fixture: v, entry: LAYOUT_PROTO, steps: async () => {} };
}

// THROWAWAY (focus ring prototype): `components/focus-proto-lab.tsx`, three ring candidates, every control drawn focused. Delete with the lab.
SCENARIOS["focus-proto"] = { fixture: "x", entry: "../components/focus-proto-lab.tsx", steps: async () => {} };

// The kit's inputs and controls in every case of the edge-case matrix (`components/kit-lab-inputs.tsx`): one page per
// family, drawn by props (no presses); `kit-inputs-<page>-large` raises every control to the Large hit targets tier.
const KIT_INPUTS = "../components/kit-lab-inputs.tsx";
for (const p of ["buttons", "fields", "numbers", "selects", "select-open", "combos", "combo-open", "toggles"]) {
  SCENARIOS[`kit-inputs-${p}`] = { fixture: p, entry: KIT_INPUTS, steps: async (app) => app.wait(400) };
  SCENARIOS[`kit-inputs-${p}-large`] = {
    fixture: p,
    entry: KIT_INPUTS,
    params: { large: true },
    steps: async (app) => app.wait(400),
  };
}

// The kit's containers and navigation in every case of their edge-case matrix (`components/kit-lab-containers.tsx`): the
// tab strip on the real `DockArea`, chips in every state, collapsibles and group headings, settings rows, the kit's tab bar.
for (const v of ["tabs", "chips", "disclosure", "settings", "nav"]) {
  SCENARIOS[`kit-containers-${v}`] = {
    fixture: v,
    entry: "../components/kit-lab-containers.tsx",
    steps: async () => {},
  };
}

// The kit's text, row, table and state family in every case of the edge-case matrix (`components/kit-rows-lab.tsx`), one
// page per scenario; width and theme come from `--size` and `--theme`.
for (const section of ["text", "files", "table", "states"]) {
  SCENARIOS[`kit-rows-${section}`] = {
    fixture: "x",
    entry: "../components/kit-rows-lab.tsx",
    params: { section },
    steps: async (app) => app.wait(400),
  };
}

// The kit's overlays in the cases of their edge-case matrix (`components/kit-lab-overlays.tsx`, one part per scenario).
// Menus, tooltips, popovers, cards and toasts are drawn in place (the window screenshot draws no overlay); dialogs and the
// palette frame are real. The lab sits under `components/`, so it renders without `nsh.json`'s type, radius and shadow scales.
for (const part of [
  "menus",
  "menus-more",
  "edges",
  "floating",
  "dialog-small",
  "dialog-title",
  "dialog-scroll",
  "dialog-none",
  "dialog-form",
  "dialog-stack",
  "dialog-settings",
  "palette-0",
  "palette-1",
  "palette-500",
  "palette-long",
]) {
  SCENARIOS[`kit-overlays-${part}`] = {
    fixture: "mixed",
    entry: "../components/kit-lab-overlays.tsx",
    params: { part },
    steps: async (app) => app.wait(part.startsWith("dialog") || part.startsWith("palette") ? 600 : 0),
  };
}

// A chat's inspector (`components/session-inspector-lab.tsx`): a Claude Code chat whose synthetic log names three subagents
// and five background tasks. States by launch parameters (a Mac shot cannot press): closed (the one quiet line), open, a
// failure that arrived (`Needs you`, opened by itself), a subagent's conversation, and a log without times.
const INSPECTOR = "../components/session-inspector-lab.tsx";
const inspector = (params: Record<string, unknown>): Scenario => ({
  fixture: "x",
  entry: INSPECTOR,
  params: { quiet: true, ...params },
  steps: async (app) => app.wait(800),
});
SCENARIOS["inspector-closed"] = inspector({});
SCENARIOS["inspector-open"] = inspector({ open: true });
SCENARIOS["inspector-needs"] = inspector({ fails: true });
SCENARIOS["inspector-drill"] = inspector({ drill: true });
SCENARIOS["inspector-notimes"] = inspector({ open: true, notimes: true });

// The README's three pictures (`scripts/readme-shots/build.sh` makes them, through `.shots/readme.test.tsx`) over the
// synthetic `showcase` fixture. build.sh runs a copy of it whose folders are synthetic git repositories, and writes the
// agents' Claude Code logs into the keeper's home of the run, which exists only once the app started (without it the
// chats say they are not linked). Presses rarely land in the Mac host, so states are reached by keys (`mod`: Ctrl on
// Linux, Cmd on a Mac): `mod+j` (the agent that waits), the palette's rows (`mod+p`, then down to the agent: the waiting
// one, the finished ones, the working ones, by name), `mod+shift+i` (the inspector), `mod+shift+g` (the project's changes,
// beside the chat), `mod+b` (the sidebar folds to its rail). The README's night picture opens the inspector's subagent by
// pressing its row (a press lands in the GTK host); the video's footage, taken on a Mac, reaches the row with three `Tab`s
// and opens it with `Enter`.
const readme = (keys: string[]): Scenario => ({
  fixture: "showcase",
  params: { sidebarWidth: 304 },
  steps: async (app) => {
    await app.wait(1500);
    for (const k of keys) {
      // `make shots` and `make a11y` run these without the synthetic logs: a row that is not there is skipped.
      if (k.startsWith("label:")) {
        if (app.shows(k)) await app.press(k);
      } else await app.keyboard.press(k);
      await app.wait(k === "down" || k === "tab" ? 300 : k === "mod+p" ? 600 : 3000);
    }
  },
});
const down = (n: number) => Array.from({ length: n }, () => "down");
SCENARIOS["readme-glance"] = readme(["mod+j", "mod+shift+i"]);
SCENARIOS["readme-review"] = readme(["mod+p", ...down(2), "enter", "mod+shift+g", "mod+b"]);
SCENARIOS["readme-night"] = readme([
  "mod+p",
  ...down(4),
  "enter",
  "mod+shift+i",
  "label:/^Move refs to plain props in components.forms, .*Open its conversation$/",
]);

// The intro video's footage (`local/video/intro/capture.sh` makes it) over the same `showcase` data and keys as the
// README's pictures: the window as it opens, `mod+j` to the agent that waits, a finished turn (the palette's third row), its
// changes beside it, the same with the file marked reviewed (`x`), and the working agent's inspector before a subagent opens.
SCENARIOS["video-start"] = readme([]);
SCENARIOS["video-jump"] = readme(["mod+j"]);
SCENARIOS["video-chat"] = readme(["mod+p", ...down(2), "enter"]);
SCENARIOS["video-review"] = readme(["mod+p", ...down(2), "enter", "mod+shift+g", "mod+b"]);
SCENARIOS["video-marked"] = readme(["mod+p", ...down(2), "enter", "mod+shift+g", "mod+b", "x"]);
SCENARIOS["video-activity"] = readme(["mod+p", ...down(4), "enter", "mod+shift+i"]);
SCENARIOS["video-subagent"] = readme(["mod+p", ...down(4), "enter", "mod+shift+i", "tab", "tab", "tab", "enter"]);
SCENARIOS["video-sidebar"] = readme(["mod+b"]);
