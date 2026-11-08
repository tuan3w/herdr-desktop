/**
 * What a command row says. A command's text is the agent's, written for a shell: a heredoc start
 * (`python3 - <<'E' p='co…`), a redirection or a pipe is noise on a line that must say what the call did. This is the
 * one rule for it, pure, so the row, the live line and the failure line all read the same. The whole command is still
 * shown, uncut, when the row is opened (`ToolDetails`): this only chooses the words of the folded line.
 */

/** Words of a shell line, quotes removed. Not a parser: enough to find a program and its first plain arguments. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    // A quoted piece glued to a word (`--include='*.ts'`) is a second match: the pieces join back by position.
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    const glued = out.length > 0 && m.index > 0 && !/\s/.test(line[m.index - 1]!);
    if (glued) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

const SCRIPT_PROGRAMS = /^(python[\d.]*|node|bun|deno|ruby|perl|php|bash|sh|zsh)$/;
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** Search flags that take a value as the next word, so the value is not mistaken for the pattern. */
const SEARCH_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-g",
  "-t",
  "-T",
  "-m",
  "-A",
  "-B",
  "-C",
  "--glob",
  "--type",
  "--include",
  "--exclude",
]);

/** How long a search pattern may be in the sentence before it is cut. */
const PATTERN_MAX = 28;

/** The part of the line that is the command: the first line, before a heredoc, redirections and what chains onto it. */
function core(command: string): { line: string; heredoc: boolean } {
  const lines = command.split("\n");
  let first = "";
  for (const l of lines) {
    if (l.trim() !== "") {
      first = l.trim();
      break;
    }
  }
  const heredoc = /<<-?\s*['"]?\w+['"]?/.test(first);
  let line = first.replace(/<<-?\s*['"]?\w+['"]?.*$/, "");
  // `cd dir && cmd` is where it runs, not what it did.
  line = line.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");
  // Redirections and the rest of a pipeline or chain are what happens to the output.
  line = line.replace(/\s\d*>>?\s*&?\S+/g, "").replace(/\s<\s*\S+/g, "");
  line = line.split(/\s(?:\|\||&&|\||;)\s/)[0] ?? line;
  return { line: line.replace(/\s+/g, " ").trim().replace(/\\$/, "").trim(), heredoc };
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The folded line's words for a command: `python3 script` for an inline script, `grep export in lib` for a search, `sed on
 * components/x.tsx` for a stream edit, else the command's first line with its heredoc, redirections and chained part
 * dropped. An empty command gives an empty string (the caller falls back to the agent's title).
 */
export function commandSubject(command: string): string {
  const { line, heredoc } = core(command);
  const w = words(line);
  const prog = (w[0] ?? "").replace(/^.*\//, "");
  if (!prog) return "";
  if (SCRIPT_PROGRAMS.test(prog)) {
    const next = w[1];
    // `python3 -`, `python3 -c '…'`, `node -e` and a heredoc are all a script written into the command.
    if (heredoc || next === "-" || next === "-c" || next === "-e" || next === "-p" || w.length === 1)
      return `${prog} script`;
  }
  if (SEARCH_PROGRAMS.has(prog)) {
    const plain: string[] = [];
    for (let i = 1; i < w.length; i += 1) {
      const a = w[i]!;
      if (a.startsWith("-")) {
        if (SEARCH_VALUE_FLAGS.has(a) && !a.includes("=")) i += 1;
      } else plain.push(a);
    }
    const [pattern, ...where] = plain;
    if (pattern) {
      const shown = cut(pattern.replace(/\\/g, ""), PATTERN_MAX);
      if (where.length === 1) return `${prog} ${shown} in ${where[0]}`;
      if (where.length > 1) return `${prog} ${shown} in ${where.length} places`;
      return `${prog} ${shown}`;
    }
  }
  if (prog === "sed" || prog === "awk") {
    const file = [...w].reverse().find((a, i) => i < w.length - 1 && !a.startsWith("-") && /[./]/.test(a));
    if (file) return `${prog} on ${file}`;
  }
  return line;
}
