/**
 * What the palette searches. One list (`SCOPES`), one prefix character each: typing `@` at the start of an empty query
 * picks Agents and the character is not part of the query; `Tab` cycles the chips; `?` lists the modes.
 */
export type PaletteScope = "all" | "agents" | "projects" | "commands" | "files" | "messages";

export interface ScopeInfo {
  id: PaletteScope;
  /** What the chip says and a screen reader names. */
  label: string;
  /** The character that selects it at the start of the query. */
  prefix?: string;
  /** The search field's placeholder. */
  placeholder: string;
  /** What it finds, for the `?` list. */
  finds: string;
}

export const SCOPES: readonly ScopeInfo[] = [
  {
    id: "all",
    label: "All",
    placeholder: "Search agents, projects and commands",
    finds: "Agents, projects, commands, machines, settings and themes",
  },
  {
    id: "agents",
    label: "Agents",
    prefix: "@",
    placeholder: "Search agents",
    finds: "Chats and terminal agents by name, project, folder and machine",
  },
  {
    id: "projects",
    label: "Projects",
    prefix: "#",
    placeholder: "Search projects",
    finds: "Projects by name, folder and machine",
  },
  {
    id: "commands",
    label: "Commands",
    prefix: ">",
    placeholder: "Search commands, settings and themes",
    finds: "Everything the app can do, settings, themes and machines",
  },
  {
    id: "files",
    label: "Files",
    prefix: "/",
    placeholder: "Search files of this project",
    finds: "Files of the project in front",
  },
  {
    id: "messages",
    label: "Messages",
    prefix: '"',
    placeholder: "Search the last messages and output",
    finds: "Titles, the last message and the last rows of a pane",
  },
];

/** The chip for a scope. */
export function scopeInfo(scope: PaletteScope): ScopeInfo {
  return SCOPES.find((s) => s.id === scope) ?? SCOPES[0];
}

/** The scope after (`1`) or before (`-1`) `scope`, wrapping: what `Tab` and `Shift+Tab` do. */
export function stepScope(scope: PaletteScope, step: 1 | -1): PaletteScope {
  const at = SCOPES.findIndex((s) => s.id === scope);
  return SCOPES[(at + step + SCOPES.length) % SCOPES.length].id;
}

/** What typing `raw` in scope `scope` means: a prefix at the start of an All query selects that scope and is not text. `?` lists the modes. */
export function readQuery(
  raw: string,
  scope: PaletteScope,
): { scope: PaletteScope; text: string; help: boolean; changed: boolean } {
  if (scope === "all" && raw.length > 0) {
    if (raw[0] === "?") return { scope, text: raw.slice(1).trim(), help: true, changed: false };
    const picked = SCOPES.find((s) => s.prefix === raw[0]);
    if (picked) return { scope: picked.id, text: raw.slice(1), help: false, changed: true };
  }
  return { scope, text: raw, help: false, changed: false };
}
