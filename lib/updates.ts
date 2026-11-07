import { signal } from "nsh";

/**
 * Notify-only update check: asks GitHub for the newest release and says so; it never downloads or installs anything.
 * `nsh/updater` does not exist in nsh 0.4.0 (nothing under `docs/dev` or `crates` names it), and installing an update is the
 * package manager's or `local/install.sh`'s job. The one host this reaches is declared in `nsh.json` `capabilities.network`
 * (GET, that one path), so the sandbox refuses anything else.
 */
const LATEST = "https://api.github.com/repos/tuan3w/herdr-desktop/releases/latest";
/** The release page must be on this repo: the URL comes from the network, and the person is about to open it. */
const RELEASE_PAGE = "https://github.com/tuan3w/herdr-desktop/";

/** A newer release than the running one. */
export interface Update {
  /** `0.1.3`, without the `v` of the tag. */
  version: string;
  /** The release page on GitHub. */
  url: string;
}

/** The newer release found this session; null until one is found, and after a check that found none or failed. */
export const availableUpdate = signal<Update | null>(null);

/** `[major, minor, patch]` of `1.2.3` or `v1.2.3`; null for anything else (a pre-release tag is not offered). */
function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `candidate` is a higher version than `current`; false when either is not `x.y.z`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let inFlight = false;
let checked = false;

/**
 * Checks once per session (a failure is retried the next time it is asked for, so going online later works). Offline,
 * a refused request, a malformed answer and a missing release all end the same way: nothing shown, one line logged.
 */
export async function checkForUpdate(current: string): Promise<void> {
  if (inFlight || checked) return;
  inFlight = true;
  try {
    const response = await fetch(LATEST, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
    checked = true;
    if (typeof release.tag_name !== "string" || typeof release.html_url !== "string" || release.draft === true || release.prerelease === true) return;
    if (!release.html_url.startsWith(RELEASE_PAGE) || !isNewer(release.tag_name, current)) return;
    availableUpdate.set({ version: release.tag_name.replace(/^v/, ""), url: release.html_url });
  } catch (e) {
    console.warn("herdr-desktop: update check failed", e);
  } finally {
    inFlight = false;
  }
}
