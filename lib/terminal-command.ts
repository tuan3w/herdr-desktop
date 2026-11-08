/**
 * The program a terminal tab runs for an agent's pane: the official `herdr` client, the same thing as running herdr in any
 * terminal emulator. Pure, so every shape and every refusal is a table in `terminal-command.test.ts`.
 *
 * The client has no way to open on one pane (`herdr --help`: `--session`, `--remote`, `--machine` and `session attach`
 * only), so it opens on the session and shows whatever herdr has focused. The caller therefore points herdr at the pane
 * first with the public API (`Herdr.focusPane`, which moves the focus of every client), and then attaches.
 *
 * The result is one `/bin/sh -c` line (that is what `Terminal`'s `command` runs), so everything composed into it is
 * validated by the rules of `native/core/src/ssh/validate.rs` and single-quoted (`shq`) on top: a hostile name never
 * becomes shell syntax. A destination follows `--` whenever ssh itself is the program.
 */

/** Where a machine's herdr is: the fields of `MachineView` the command needs. */
export interface TerminalTarget {
  /** This computer. */
  local: boolean;
  /** `user@host` or an ssh config alias; ignored for this computer. */
  dest?: string | null;
  /** ssh port when not the default. */
  port?: number | null;
  /** The herdr session when not the default one. */
  session?: string | null;
}

export type TerminalCommand = { command: string } | { why: string };

/** Single-quotes `s` for a POSIX shell: one word whose value is exactly `s` (`native/core/src/ssh/validate.rs`). */
export const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const DEST_MAX = 255;
const DEST_CHARS = /^[A-Za-z0-9._@:[\]-]+$/;
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;

/** A destination ssh may be given: 1 to 255 characters of letters, digits and `. _ @ : [ ] -`, never a leading dash. */
export const validDest = (dest: string): boolean =>
  dest.length > 0 && dest.length <= DEST_MAX && !dest.startsWith("-") && DEST_CHARS.test(dest);

/** A herdr session name: `[A-Za-z0-9._-]+`, not `.` or `..` (it becomes a directory in the socket path). */
export const validSession = (name: string): boolean => NAME_CHARS.test(name) && name !== "." && name !== "..";

/** The places the client lives in when the app was started from a launcher whose `PATH` is short. */
const PATH_HINT = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';

/** The command that opens the herdr client for `target`, or why it cannot be built. */
export function herdrClientCommand(target: TerminalTarget): TerminalCommand {
  const session = target.session ?? null;
  if (session !== null && !validSession(session)) return { why: "The herdr session name is not acceptable" };
  const flag = session === null ? "" : ` --session ${shq(session)}`;
  if (target.local) return { command: `${PATH_HINT} exec herdr${flag}` };

  const dest = target.dest ?? "";
  if (!validDest(dest)) return { why: "The machine's destination is not acceptable" };
  const port = target.port ?? null;
  if (port === null) return { command: `${PATH_HINT} exec herdr --remote ${shq(dest)}${flag}` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { why: "The machine's ssh port is not acceptable" };
  // `herdr --remote` takes no port: ssh is the program, with the destination after `--` and one quoted word for the far shell.
  const far = shq(`herdr${flag}`);
  return { command: `exec ssh -t -p ${port} -- ${shq(dest)} ${far}` };
}
