import { Files, Herdr, Pages } from "herdr-desktop/native";
import { Clipboard, openUrl } from "nsh";

import { notify } from "#kit";
import { isImageName, routeLink } from "#lib/files";
import type { LinkPanel } from "#lib/link-panel";
import { browseFiles, viewFile } from "#lib/open-files";

/** Where a pressed link is: the pane's machine, the folder a relative path is looked for in, and its surface's side panel. */
export interface LinkContext {
  machine: string;
  cwd?: string | null;
  /** The side panel of the chat or terminal the link is in; without one a link opens the old way. */
  panel?: LinkPanel;
  /** `mod` was held: the old way (a file's tab, the browser) instead of the panel. */
  external?: boolean;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What a pressed link does, for the terminal, Markdown and tool output alike (`routeLink` decides). With a side panel, a
 * file opens in it at its line (a picture fitted) and so does a web page: an https address, this computer's own
 * `localhost`, and a remote machine's `localhost` through a tunnel. `mod` held, or no panel, is the old way: a file opens
 * in the file viewer's tab and an address in the browser. A folder always opens in the browser of files. A path is found
 * in the pane's folder or the two above it on the pane's machine. Anything else is copied, never opened. A failure says
 * what happened in a toast (which screen readers hear too).
 */
export async function openLink(
  kind: "url" | "path",
  target: string,
  line?: number | null,
  col?: number | null,
  at?: LinkContext,
): Promise<void> {
  const machine = at ? Herdr.machines().find((m) => m.id === at.machine) : undefined;
  const panel = at?.panel && !at.external ? at.panel : undefined;
  const route = routeLink(kind, target, {
    local: machine?.local ?? true,
    loopback: Pages.localhost(target) !== null,
    panel: panel !== undefined,
  });
  if (route === "file" && at) {
    const folder = at.cwd ?? (/^(\/|~)/.test(target) ? "/" : null);
    if (folder === null) {
      notify("Cannot tell which folder that path is relative to", { type: "error" });
      return;
    }
    try {
      const found = await Files.find(at.machine, folder, target);
      if (found.kind === "dir") browseFiles(at.machine, found.path);
      else if (!panel) viewFile(at.machine, found.path, line);
      else if (isImageName(found.path)) panel.show({ kind: "picture", machine: at.machine, path: found.path });
      else panel.show({ kind: "file", machine: at.machine, path: found.path, line: line ?? undefined });
    } catch (e) {
      notify(message(e), { type: "error" });
    }
    return;
  }
  if (route === "page" && at) {
    // The browser cannot reach a remote machine's localhost: the page is shown here, through the tunnel, `mod` or not.
    if (at.panel) at.panel.show({ kind: "web", url: target, machine: at.machine });
    else {
      await Clipboard.writeText(target);
      notify(`Address copied. ${target} is on ${machine?.name ?? at.machine}: open it from a chat or terminal there.`);
    }
    return;
  }
  if (route === "panel" && panel) {
    panel.show({ kind: "web", url: target });
    return;
  }
  if (route === "browser") {
    try {
      const { opened } = await openUrl(target);
      if (!opened) notify("Nothing on this computer opens that address", { type: "error" });
    } catch (e) {
      notify(`Could not open the address: ${message(e)}`, { type: "error" });
    }
    return;
  }
  const text = kind === "path" && line ? `${target}:${line}${col ? `:${col}` : ""}` : target;
  await Clipboard.writeText(text);
  notify(kind === "path" ? "Path copied" : "Address copied");
}
