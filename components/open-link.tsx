import { Files, Herdr, Pages } from "herdr-desktop/native";
import { Clipboard, openUrl } from "nsh";

import { notify } from "#kit";
import { pageRequest, routeLink } from "#lib/files";
import { browseFiles, viewFile } from "#lib/open-files";

/** Where a pressed link is: the pane's machine, and the folder a relative path is looked for in. */
export interface LinkContext {
  machine: string;
  cwd?: string | null;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What a pressed link does, for the terminal, Markdown and tool output alike (`routeLink` decides). A file path opens in
 * the file viewer (a folder in the browser), found in the pane's folder or the two above it on the pane's machine. A
 * web address on a remote machine's own `localhost` opens as a page here, through a tunnel; on this computer it, and
 * any other http or https address, opens in the browser. Anything else is copied, never opened. Each says what
 * happened in a toast (which screen readers hear too).
 */
export async function openLink(
  kind: "url" | "path",
  target: string,
  line?: number | null,
  col?: number | null,
  at?: LinkContext,
): Promise<void> {
  const machine = at ? Herdr.machines().find((m) => m.id === at.machine) : undefined;
  const route = routeLink(kind, target, { local: machine?.local ?? true, loopback: Pages.localhost(target) !== null });
  if (route === "file" && at) {
    const folder = at.cwd ?? (/^(\/|~)/.test(target) ? "/" : null);
    if (folder === null) {
      notify("Cannot tell which folder that path is relative to", { type: "error" });
      return;
    }
    try {
      const found = await Files.find(at.machine, folder, target);
      if (found.kind === "dir") browseFiles(at.machine, found.path);
      else viewFile(at.machine, found.path, line);
    } catch (e) {
      notify(message(e), { type: "error" });
    }
    return;
  }
  if (route === "page" && at) {
    pageRequest.set({ machine: at.machine, url: target });
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
