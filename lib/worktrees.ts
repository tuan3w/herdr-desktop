import { Herdr } from "herdr-desktop/native";

import type { BoardProject, WorktreeLookup } from "herdr-desktop/native";

import { projectFolder } from "#lib/sidebar";

/**
 * The rules of worktrees that are not drawing: which branch names are acceptable, the name suggested for a new one, and
 * when the branches of a project's checkouts are looked up. Reading and making worktrees is Rust (`Herdr.worktrees`,
 * `Herdr.createWorktree`) through herdr's API; a name travels only as a parameter and is checked again there
 * (`herdr_core::worktree::branch_error`, same rules and same table of examples in both tests).
 */

/** The longest branch name, in bytes (the same cap as the Rust check). */
export const MAX_BRANCH_BYTES = 200;

const BYTES = new TextEncoder();

/**
 * Why `name` cannot name a new branch, in a sentence for the form, or `undefined` when it can. An empty name is fine:
 * herdr then names the branch and the folder. A bad name is never cleaned for the person: they see the reason and fix it.
 * The rules are git's ref-name rules, narrowed to the ASCII a shell and a path take without surprise.
 */
export function branchError(name: string): string | undefined {
  const branch = name.trim();
  if (branch === "") return undefined;
  if (BYTES.encode(branch).length > MAX_BRANCH_BYTES) return "A branch name is at most 200 bytes.";
  if (/[\s\p{Cc}]/u.test(branch)) return "No spaces or control characters in a branch name.";
  if (branch.startsWith("-")) return "A branch name can't start with -.";
  if (/[~^:?*[\\]/.test(branch)) return "A branch name can't contain ~ ^ : ? * [ or \\.";
  if (branch.includes("..") || branch.includes("@{") || branch === "@") return "A branch name can't contain .. or @{.";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//"))
    return "A branch name can't start or end with / or hold an empty part.";
  if (branch.endsWith(".")) return "A branch name can't end with a dot.";
  if (branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))
    return "No part of a branch name may start with a dot or end in .lock.";
  if (!/^[A-Za-z0-9\-_./+]+$/.test(branch)) return "Use letters, digits and - _ . / + in a branch name.";
  return undefined;
}

const ADJECTIVES = [
  "brave",
  "calm",
  "bright",
  "quiet",
  "lucky",
  "swift",
  "gentle",
  "bold",
  "sunny",
  "misty",
  "amber",
  "cosmic",
  "keen",
  "merry",
  "noble",
  "witty",
];
const NOUNS = [
  "meadow",
  "river",
  "stone",
  "cloud",
  "forest",
  "harbor",
  "lantern",
  "maple",
  "comet",
  "canyon",
  "falcon",
  "garden",
  "island",
  "orchard",
  "summit",
  "willow",
];

/**
 * A branch name to start the `Branch` field with, in herdr's own shape (`worktree/brave-meadow-45e8`) and not the branch
 * of any checkout `taken` names. Why a name and not an empty field: a name that is shown can be read, changed and
 * recognised later on the desk. `random` is injected so a test is not at the mercy of chance.
 */
export function suggestBranch(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length) % list.length];
  for (;;) {
    const tag = Math.floor(random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    const name = `worktree/${pick(ADJECTIVES)}-${pick(NOUNS)}-${tag}`;
    if (!used.has(name)) return name;
  }
}

/** What a project's checkouts were when their branches were last looked up: a key, so an unchanged project is not asked twice. */
const looked = new Map<string, string>();

/**
 * Asks herdr for the branches of a project's checkouts when the project has several (the sidebar names each by its
 * branch) and its set of checkouts is one not asked about yet. Offline projects are left alone. The answer is kept by the
 * engine, which ticks, so nothing is returned: a lookup that finds nothing leaves the folder names, as before.
 */
export function lookUpBranches(project: BoardProject): void {
  if (project.offline || project.checkouts.length < 2) return;
  const folder = projectFolder(project);
  const stamp = project.checkouts.map((c) => c.path).join("\n");
  if (folder === "" || looked.get(project.key) === stamp) return;
  looked.set(project.key, stamp);
  void Herdr.worktrees(project.machine, folder).catch(() => looked.delete(project.key));
}

/** Forgets what was looked up, for the next opening of the app or a test. */
export const forgetLookups = () => looked.clear();

/** The checkout the lookup lists at `folder`, if any. */
export const checkoutAt = (found: WorktreeLookup | undefined, folder: string) =>
  found?.checkouts.find((c) => c.path.replace(/\/+$/, "") === folder.trim().replace(/\/+$/, ""));
