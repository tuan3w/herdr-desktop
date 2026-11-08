import type { CommandSpec } from "herdr-desktop/native";

import { type Action, actions, openSettings, runAction } from "#lib/actions";
import {
  announceOutput,
  checkUpdates,
  codeLineNumbers,
  codeWhitespace,
  codeWrap,
  diffSplit,
  largeTargets,
  reduceMotionOverride,
} from "#lib/settings";

/** What a command asks for after it, one step each. */
export type ArgKind = "project" | "agentKind" | "file";

/**
 * A command of the palette as the app knows it: what Rust ranks (`CommandSpec`) and what only the app can say or do
 * (the key, whether it is on, why it cannot run, how to run it).
 */
export interface PaletteCommand {
  spec: CommandSpec;
  shortcut?: string;
  checked?: boolean;
  /** Why it cannot run now; set exactly when `spec.disabled`. */
  reason?: string;
  /** What it asks for next. A command with arguments does not run on Enter: it opens the next step. */
  args?: ArgKind[];
  run: () => void;
}

/** Words the palette teaches beside what the label says, by command id (a natural phrase finds the command). */
const VERBS: Record<string, string[]> = {
  nextAttention: ["next that needs you", "jump to waiting", "go to blocked"],
  prevAttention: ["previous that needs you"],
  board: ["go home", "show board", "home"],
  newAgent: ["new session", "start agent", "new chat"],
  newSessionIn: ["new session", "new agent session", "start session", "start agent", "new chat"],
  browseFilesIn: ["browse files", "files in"],
  openFile: ["open file", "find file", "go to file"],
  switcher: ["recent", "switch to"],
  settings: ["preferences", "open settings"],
  sidebar: ["toggle sidebar", "hide sidebar", "show sidebar"],
  machines: ["add machine", "connect computer"],
  closePane: ["close terminal", "kill agent"],
  startTerminalAgent: ["start terminal agent", "new terminal agent"],
  copyCode: ["copy snippet"],
  copyReply: ["copy answer"],
};

/** Shown on the empty palette: the command for what waits, then these. */
const SUGGEST: Record<string, "always" | "needsYou"> = {
  nextAttention: "needsYou",
  newSessionIn: "always",
  switcher: "always",
  settings: "always",
};

/** Commands that only make sense at a pane or in a chat, and the sentence that says what to do first. */
const NEEDS: Record<string, string> = {
  focusPane: "Open an agent first",
  search: "Open an agent first",
  copyCode: "Open a chat first",
  copyReply: "Open a chat first",
  closeTab: "Nothing to close on the board",
  showChat: "This agent has no chat to show",
  showTerminal: "This chat is not read from a terminal",
  links: "Open a terminal agent first",
  newTab: "Open an agent first",
  renameWorkspace: "Open an agent first",
  renameTab: "Open an agent first",
  renamePane: "Open an agent first",
  splitHerdrRight: "Open a terminal agent first",
  splitHerdrDown: "Open a terminal agent first",
  closePane: "Open a terminal agent first",
  closeHerdrTab: "Open an agent first",
  closeWorkspace: "Open an agent first",
  moveRight: "Open a second tab first",
  moveDown: "Open a second tab first",
  moveLeft: "Open a second tab first",
  moveUp: "Open a second tab first",
  moveOther: "Split first: there is one group",
  focusOther: "Split first: there is one group",
  mergeSplits: "There is one group: nothing to merge",
  splitRight: "The board has no split: open an agent first",
  splitDown: "The board has no split: open an agent first",
};

/** Settings that are a switch: on the palette they flip, and say whether they are on. */
const SWITCHES: { id: string; label: string; words: string[]; signal: { (): boolean; set: (v: boolean) => void } }[] = [
  { id: "reduceMotion", label: "Reduce motion", words: ["animation", "accessibility"], signal: reduceMotionOverride },
  { id: "largeTargets", label: "Large hit targets", words: ["touch", "accessibility", "bigger"], signal: largeTargets },
  { id: "announceOutput", label: "Announce agent output", words: ["screen reader", "speak"], signal: announceOutput },
  { id: "codeWrap", label: "Wrap long code lines", words: ["code", "editor"], signal: codeWrap },
  { id: "codeLineNumbers", label: "Line numbers in code", words: ["code", "gutter"], signal: codeLineNumbers },
  { id: "codeWhitespace", label: "Show whitespace in code", words: ["code", "tabs", "spaces"], signal: codeWhitespace },
  { id: "diffSplit", label: "Side by side diffs", words: ["diff", "split", "changes"], signal: diffSplit },
  { id: "checkUpdates", label: "Check for updates", words: ["release", "version"], signal: checkUpdates },
];

/** Palette-only commands: the two-step forms of things the app does (`runWith` in `lib/palette/steps.ts`). */
const TWO_STEP: { id: string; label: string; group: string; args: ArgKind[]; words: string[] }[] = [
  { id: "newSessionIn", label: "New agent session in…", group: "Go", args: ["project", "agentKind"], words: ["chat"] },
  { id: "browseFilesIn", label: "Browse files in…", group: "App", args: ["project"], words: ["folder", "viewer"] },
  { id: "openFile", label: "Open file…", group: "App", args: ["file"], words: ["quick open", "viewer"] },
];

/**
 * Every command the palette can run, now: the actions of the app (`actions()`), the settings that are a switch and the
 * two-step forms. Taken once when the palette opens; what a command does is read when it runs.
 */
export function paletteCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = actions().map((a: Action) => {
    const theme = a.id.startsWith("theme:");
    const disabled = a.disabled === true;
    return {
      spec: {
        id: a.id,
        label: a.label,
        group: a.group,
        keywords: a.keywords ?? [],
        verbs: VERBS[a.id] ?? [],
        kind: theme ? "theme" : "command",
        disabled,
        suggest: SUGGEST[a.id],
      },
      shortcut: a.shortcut,
      checked: a.checked,
      reason: disabled ? (NEEDS[a.id] ?? "Not available here") : undefined,
      run: () => runAction(a.id),
    };
  });
  for (const s of SWITCHES)
    out.push({
      spec: {
        id: `setting:${s.id}`,
        label: s.label,
        group: "Settings",
        keywords: s.words,
        verbs: [],
        kind: "setting",
        disabled: false,
      },
      checked: s.signal(),
      run: () => s.signal.set(!s.signal()),
    });
  out.push({
    spec: {
      id: "setting:all",
      label: "Settings…",
      group: "Settings",
      keywords: ["preferences", "options", "text size", "theme", "notifications", "accessibility"],
      verbs: [],
      kind: "setting",
      disabled: false,
    },
    run: () => openSettings(),
  });
  for (const t of TWO_STEP)
    out.push({
      spec: {
        id: t.id,
        label: t.label,
        group: t.group,
        keywords: t.words,
        verbs: VERBS[t.id] ?? [],
        kind: "command",
        disabled: false,
        suggest: SUGGEST[t.id],
      },
      args: t.args,
      // A two-step command runs from its steps (`runWith`); asked to run without them it opens the first step.
      run: () => undefined,
    });
  return out;
}
