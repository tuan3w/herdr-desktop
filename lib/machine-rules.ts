/**
 * What the machine form accepts, mirrored from `native/core/src/ssh/validate.rs` so a mistake shows next to its field
 * before anything is sent. The Rust side stays the authority: it checks again and its message is shown too. A
 * destination reaches `ssh` as an argument and a remote shell, so the rule is a whitelist, not a blacklist.
 */

/** The longest destination ssh accepts in practice (a DNS name is at most 253 characters). */
const DEST_MAX = 255;
const DEST_CHARS = /^[A-Za-z0-9._@:[\]-]+$/;
const SESSION_CHARS = /^[A-Za-z0-9._-]+$/;

/** What is wrong with a destination (`user@host`, a host name, an address or an ssh config alias), `undefined` when nothing. */
export function destinationError(dest: string): string | undefined {
  if (dest === "") return "Enter the host to connect to.";
  if (dest.length > DEST_MAX) return "A destination has at most 255 characters.";
  // ssh would read a leading dash as an option (`-oProxyCommand=...` runs a command).
  if (dest.startsWith("-")) return "A destination cannot start with a dash.";
  if (!DEST_CHARS.test(dest)) return "Use letters, digits and . _ @ : [ ] - only, no spaces.";
  return undefined;
}

/** What is wrong with a herdr session name; empty means herdr's default session. */
export function sessionError(session: string): string | undefined {
  if (session === "") return undefined;
  if (!SESSION_CHARS.test(session)) return "Use letters, digits and . _ - only, no spaces.";
  // The name becomes a directory in the socket's path.
  if (session === "." || session === "..") return "A session name cannot be . or ..";
  return undefined;
}

/** What is wrong with a port; `null` means ssh's default. */
export function portError(port: number | null): string | undefined {
  if (port === null) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "A port is a whole number from 1 to 65535.";
  return undefined;
}

/** The rule text for an empty machine name; it is the one mistake a name can have, so the form tests `trim() === ""` itself. */
export const NAME_MISSING = "Give the machine a name.";

/** The field a message of `Herdr.saveMachine` is about (its texts start with the field's name), `undefined` for a failure of the whole save. */
export function fieldOfRejection(message: string): "name" | "destination" | "session" | "port" | undefined {
  const text = message.toLowerCase();
  if (text.startsWith("invalid destination")) return "destination";
  if (text.startsWith("invalid session")) return "session";
  if (text.startsWith("invalid port")) return "port";
  if (text.startsWith("give the machine a name")) return "name";
  return undefined;
}
