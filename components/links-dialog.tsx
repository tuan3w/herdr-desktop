import { Clipboard, openUrl, signal, Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";
import type { PaneLink } from "herdr-desktop/native";
import { Modal, notify } from "./kit";

/** Whether a web link may be handed to the system browser: only http and https, the schemes `nsh.json` grants. */
export const opensInBrowser = (target: string): boolean => /^https?:\/\//i.test(target);

/**
 * What a pressed link does, for the mirror and for this list alike. A web address opens in the browser. A file path
 * is copied: the file viewer is not built yet, and a path on another machine is not one this computer can open. Both
 * say what happened, in a toast (which screen readers hear too).
 */
export async function openLink(kind: PaneLink["kind"], target: string, line?: number | null, col?: number | null): Promise<void> {
  if (kind === "url" && opensInBrowser(target)) {
    try {
      const { opened } = await openUrl(target);
      if (!opened) notify("Nothing on this computer opens that address", { type: "error" });
    } catch (e) {
      notify(`Could not open the address: ${e instanceof Error ? e.message : String(e)}`, { type: "error" });
    }
    return;
  }
  const text = kind === "path" && line ? `${target}:${line}${col ? `:${col}` : ""}` : target;
  await Clipboard.writeText(text);
  notify(kind === "path" ? "Path copied" : "Address copied");
}

/**
 * Every link of the pane in a list, because pressing one in the mirror needs a pointer. A search field narrows it,
 * Up and Down move, Enter opens a web link or copies a path, Escape closes. The mirror's rows are read when it opens.
 */
export function LinksDialog(props: { open: boolean; links: PaneLink[]; onClose: () => void }) {
  const query = signal("");
  const items = (): CommandItem[] =>
    props.links.map((l, i) => ({ id: String(i), label: l.text, group: l.kind === "url" ? "Web addresses" : "Files", keywords: [l.target] }));
  const close = () => {
    query.set("");
    props.onClose();
  };
  return (
    <Modal open={props.open} onClose={close} title="Links in this pane" description="Enter opens a web address or copies a file path.">
      <View class="gap-2">
        <Command
          items={items()}
          query={query()}
          autoFocus
          accessibilityLabel="Links"
          searchAccessibilityLabel="Search links"
          placeholder="Search links"
          listClass="max-h-[320px]"
          onQueryChange={({ query: q }) => query.set(q)}
          onSelect={({ id }) => {
            const link = props.links[Number(id)];
            close();
            if (link) void openLink(link.kind, link.target, link.line, link.col);
          }}
          onCancel={close}
          empty={<Text class="px-3 py-4 text-sm text-muted-foreground">{props.links.length === 0 ? "No links in this pane" : "No link matches"}</Text>}
        />
      </View>
    </Modal>
  );
}
