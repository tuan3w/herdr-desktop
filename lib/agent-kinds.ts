/**
 * The agents `Start agent` offers, by the kind herdr knows them as (`agent.start` `kind`; the list is the schema's
 * `AgentKind` in `docs/herdr-api.schema.json`). The first four are what the owner runs most; `agent-kinds.test.ts`
 * fails when herdr's list and this one drift apart after a `make schema`.
 */
export interface AgentKind {
  /** What `Herdr.startAgent` takes as `agent`. */
  kind: string;
  /** What the person calls it. */
  title: string;
}

export const AGENT_KINDS: AgentKind[] = [
  { kind: "omp", title: "omp" },
  { kind: "claude", title: "Claude Code" },
  { kind: "codex", title: "Codex" },
  { kind: "pi", title: "pi" },
  { kind: "antigravity_cli", title: "Antigravity CLI" },
  { kind: "copilot", title: "GitHub Copilot" },
  { kind: "cursor", title: "Cursor" },
  { kind: "devin", title: "Devin" },
  { kind: "droid", title: "Droid" },
  { kind: "grok", title: "Grok" },
  { kind: "hermes", title: "Hermes" },
  { kind: "kilo", title: "Kilo" },
  { kind: "kimi", title: "Kimi" },
  { kind: "mastracode", title: "Mastra Code" },
  { kind: "opencode", title: "opencode" },
  { kind: "qodercli", title: "Qoder CLI" },
  { kind: "qwen", title: "Qwen" },
];

/** What is wrong with the folder an agent starts in, `undefined` when nothing. A machine's home is not known here, so `~` is not offered. */
export function folderError(folder: string): string | undefined {
  const path = folder.trim();
  if (path === "") return "Enter the folder the agent works in.";
  if (!path.startsWith("/")) return "Enter an absolute path on that machine, starting with /.";
  if (/[\0\r\n]/.test(path)) return "A folder path is one line.";
  return undefined;
}
