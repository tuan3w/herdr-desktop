import { Sessions } from "herdr-desktop/native";
import { announce } from "nsh";

import { notify } from "#kit";
import { openSession } from "#lib/dock";
import { browseFiles, viewFile } from "#lib/files";
import { projectOf } from "#lib/herdr";
import { agentChoices, rememberStart, startFailure } from "#lib/new-session";
import type { AgentChoice } from "#lib/new-session";
import type { PaletteCommand } from "#lib/palette/commands";
import { projectFolder } from "#lib/sidebar";
import { fold } from "#lib/text";

/**
 * Commands with arguments are two steps, three at most: choosing the command moves to the first step over that kind's
 * candidates, the choice stays as a chip in the search bar, `Backspace` on an empty query removes it. A natural phrase
 * (`new session pay`) opens step one already filtered to what follows it.
 */

/** The step a typed phrase opens: the longest command phrase at the start of `text`, and what follows it. */
export function phraseOf(
  text: string,
  commands: readonly PaletteCommand[],
): { command: PaletteCommand; rest: string } | null {
  const said = fold(text).replace(/\s+/g, " ").trimStart();
  let best: { command: PaletteCommand; length: number } | null = null;
  for (const command of commands) {
    if (!command.args) continue;
    const phrases = [command.spec.label.replace(/…$/, ""), ...(command.spec.verbs ?? [])].map((p) => fold(p).trim());
    for (const phrase of phrases) {
      // The phrase must be a whole word run at the start, followed by a space and something more.
      if (said.length > phrase.length + 1 && said.startsWith(`${phrase} `) && phrase.length > (best?.length ?? 0))
        best = { command, length: phrase.length };
    }
  }
  return best && { command: best.command, rest: said.slice(best.length + 1).trimStart() };
}

/** The agents a machine can start a chat with, the ones it lacks dimmed (`AgentChoice.installed`); the probe is a round trip to the machine. */
export async function agentKindsOn(machine: string): Promise<AgentChoice[]> {
  return agentChoices(await Sessions.probe(machine));
}

/**
 * Runs a two-step command with what the steps chose, in order. `New agent session in…` starts a chat in the project's
 * folder and opens it: nothing is sent until the person types.
 */
export async function runWith(command: PaletteCommand, values: readonly string[]): Promise<void> {
  const id = command.spec.id;
  if (id === "newSessionIn") {
    const project = projectOf(values[0]);
    if (!project) return;
    const folder = projectFolder(project);
    try {
      const ref = await Sessions.start(project.machine, { agent: values[1], cwd: folder });
      // What the form remembers for its next opening is remembered the same way.
      rememberStart(project.machine, values[1], folder);
      announce(`Started a chat in ${project.name}`);
      await openSession(ref.machine, ref.id);
    } catch (e) {
      const said = startFailure(e instanceof Error ? e.message : String(e), project.machineName);
      notify(`${said.text} ${said.next}`, { type: "error" });
    }
  } else if (id === "browseFilesIn") {
    const project = projectOf(values[0]);
    if (project) browseFiles(project.machine, projectFolder(project));
  } else if (id === "openFile") {
    // `values[0]` is `<machine>\n<absolute path>`: the file step knows the root it searched.
    const [machine, path] = values[0].split("\n");
    viewFile(machine, path);
  }
}
