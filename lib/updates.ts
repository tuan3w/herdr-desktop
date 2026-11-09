import { signal } from "nsh";

/**
 * Notify-only update check: asks GitHub for the releases and says what it found; it never downloads or installs anything.
 * `nsh/updater` does not exist in nsh 0.4.0, and installing is `scripts/install.sh`'s job (`UPDATE_COMMAND`). The one host
 * this reaches is declared in `nsh.json` `capabilities.network` (GET, that one path), so the sandbox refuses anything else.
 *
 * The list, not `releases/latest`: GitHub's latest skips pre-releases, and every release of the 0.1.0-alpha line is one, so
 * an alpha never heard of the next alpha (owner, 2026-11-09, on alpha.5 with alpha.6 out: "not sure how to update?").
 */
const RELEASES = "https://api.github.com/repos/tuan3w/herdr-desktop/releases";
/** The release page must be on this repo: the URL comes from the network, and the person is about to open it. */
const RELEASE_PAGE = "https://github.com/tuan3w/herdr-desktop/";
/** What updates the app: the install script again, which takes the newest release, pre-releases included (README). */
export const UPDATE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/tuan3w/herdr-desktop/main/scripts/install.sh | sh";

/** What the last check found; `idle` before the first one this session. */
export type UpdateCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "failed"; reason: string }
  | { kind: "newer"; version: string; url: string };

export const updateCheck = signal<UpdateCheck>({ kind: "idle" });

const STAGES = ["alpha", "beta", "rc"];

/** `[major, minor, patch, stage, n]` of `1.2.3` or `v1.2.3-alpha.4`; a stable release has stage 3 (after `rc`). Null for anything else (`edge`, `nightly`). */
function parse(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(version.trim());
  if (!m) return null;
  const stage = m[4] ? STAGES.indexOf(m[4]) : STAGES.length;
  return [Number(m[1]), Number(m[2]), Number(m[3]), stage, m[5] ? Number(m[5]) : 0];
}

/** Whether version `a` is higher than `b`, pre-releases ordered as semver orders them; false when either is unreadable. */
function higher(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Whether `candidate` is offered over the running `current`: higher (`0.1.0-alpha.2` after `alpha.1`, before `0.1.0`), and
 * never a pre-release to a stable release, so who left the alpha line stays off it.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (parse(current)?.[3] === STAGES.length && parse(candidate)?.[3] !== STAGES.length) return false;
  return higher(candidate, current);
}

/**
 * Checks once per session; a failure is retried the next time it is asked for (or by `Try again`), so going online later
 * works. Says what happened either way: up to date, the newer version, or why it could not tell.
 */
export async function checkForUpdate(current: string): Promise<void> {
  const now = updateCheck();
  if (now.kind === "checking" || now.kind === "current" || now.kind === "newer") return;
  updateCheck.set({ kind: "checking" });
  try {
    const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const releases = (await response.json()) as unknown;
    if (!Array.isArray(releases)) throw new Error("GitHub's answer was not a list of releases");
    let best: { version: string; url: string } | null = null;
    for (const r of releases as { tag_name?: unknown; html_url?: unknown; draft?: unknown }[]) {
      if (typeof r.tag_name !== "string" || typeof r.html_url !== "string" || r.draft === true) continue;
      if (!r.html_url.startsWith(RELEASE_PAGE) || !isNewer(r.tag_name, current)) continue;
      if (best && !higher(r.tag_name, best.version)) continue;
      best = { version: r.tag_name.replace(/^v/, ""), url: r.html_url };
    }
    updateCheck.set(best ? { kind: "newer", ...best } : { kind: "current" });
  } catch (e) {
    console.warn("herdr-desktop: update check failed", e);
    updateCheck.set({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
  }
}
