import { Files, Herdr, Pages } from "herdr-desktop/native";
import { Clipboard, cleanup, effect, keymap, signal, untracked, View } from "nsh";

import type { FileData, PageView } from "herdr-desktop/native";

import { Browser } from "#components/browser";
import { FileViewer } from "#components/file-viewer";
import { ImageView } from "#components/image-view";
import { Btn, Clipped, Empty, Icon, IconButton, type IconName, notify, snug } from "#kit";
import type { Via } from "#lib/browser";
import { loadThumb, pictureDimensions, thumbKey, thumbState } from "#lib/chat-pictures";
import { parentOf } from "#lib/files";
import { BAR } from "#lib/layout";
import { LINK_PANEL_WIDTH, type LinkPanel, type PanelLink } from "#lib/link-panel";
import { viewFile } from "#lib/open-files";
import { focusComposer } from "#lib/pane-input";
import { shortPath } from "#lib/session-text";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What the header says and offers for one link. */
interface Head {
  icon: IconName;
  title: string;
  /** Muted after the title: the host, or the folder. */
  sub: string;
  /** The whole address or path: the title's tooltip and part of its name. */
  full: string;
  /** What `Copy link` copies. */
  copy: string;
  /** `Open as a tab`: the old place of a file or a picture. */
  out: { label: string; onPress: () => void };
}

/** One `BAR`-high line, as the chat's header: the kind's glyph, the title, where it is, and the panel's actions. A page has none: the browser's toolbar is its line. */
function PanelHeader(props: { head: Head; onClose: () => void }) {
  return (
    <View style={{ minHeight: BAR }} class="shrink-0 flex-row items-center gap-2 border-b border-border pl-4 pr-2">
      <Icon name={props.head.icon} size={14} tone="muted-foreground" />
      <View
        role="header"
        accessibilityLabel={`${props.head.title}, ${props.head.full}`}
        class="min-w-0 flex-1 flex-row items-center gap-2"
      >
        <Clipped
          label={props.head.full}
          fade={["from-background/0 to-background"]}
          boxClass="min-w-0 shrink"
          class="text-sm font-medium text-foreground"
        >
          {props.head.title}
        </Clipped>
        {/* Where it is stays in view (it is what a person checks before trusting a page): the title gives way first. */}
        <If when={props.head.sub}>
          <Clipped
            fade={["from-background/0 to-background"]}
            boxClass="min-w-0 max-w-[45%] shrink-0"
            class="text-xs text-muted-foreground"
          >
            {props.head.sub}
          </Clipped>
        </If>
        <View class="flex-1" />
      </View>
      <IconButton
        icon="copy"
        label="Copy link"
        onPress={() => void Clipboard.writeText(props.head.copy).then(() => notify("Link copied"))}
      />
      <Btn small variant="ghost" icon="external-link" label={props.head.out.label} onPress={props.head.out.onPress} />
      <IconButton icon="x" label="Close" shortcut="Esc" onPress={props.onClose} />
    </View>
  );
}

/** The panel's content height, measured: the viewers draw at a number, not at "the rest". */
function useBody() {
  const height = signal(0);
  return { height, onLayout: (e: { bounds: { size: { height: number } } }) => height.set(e.bounds.size.height) };
}

/**
 * A web page, in the embedded browser (`Browser`, which holds Copy link, Open in browser and Close in its one line). One of
 * this computer loads as it is; a page of a remote machine's own `localhost` is reached through a tunnel on its shared ssh
 * connection, bound to this computer's loopback address, made when the panel shows it and removed when it closes or
 * shows something else (`Pages.open`, `Pages.closePage`).
 */
function WebPanel(props: {
  link: Extract<PanelLink, { kind: "web" }>;
  onClose: () => void;
  onLeave?: () => void;
  active: boolean;
}) {
  const machine = props.link.machine;
  if (machine === undefined) {
    return <Browser url={props.link.url} onClose={props.onClose} onLeave={props.onLeave} active={props.active} />;
  }
  const page = signal<PageView | null>(null);
  const failure = signal<string | null>(null);
  let attempt = 0;
  const start = async () => {
    const mine = ++attempt;
    failure.set(null);
    try {
      const opened = await Pages.open(machine, props.link.url);
      if (mine !== attempt) {
        // The panel closed or showed another link while the tunnel was being made.
        Pages.closePage(opened.id);
        return;
      }
      page.set(opened);
    } catch (e) {
      if (mine === attempt) failure.set(reason(e));
    }
  };
  void start();
  cleanup(() => {
    attempt++;
    const open = page();
    if (open) Pages.closePage(open.id);
  });
  const via = (): Via | undefined => {
    const p = page();
    return p ? { local: new URL(p.url).origin, remote: new URL(p.remoteUrl).origin } : undefined;
  };
  const machineName = () => Herdr.machines().find((m) => m.id === machine)?.name ?? machine;
  return (
    <Browser
      url={props.link.url}
      via={via()}
      waiting={page() === null && failure() === null}
      place={`${machineName()} · through ssh`}
      failure={failure()}
      onRetry={() => void start()}
      onClose={props.onClose}
      onLeave={props.onLeave}
      active={props.active}
    />
  );
}

/** A file at its line, drawn by the file viewer itself (`FileViewer` with `panelHeight`); `Open as a tab` is its old place. */
function FilePanel(props: { link: Extract<PanelLink, { kind: "file" }>; cwd: string; onClose: () => void }) {
  const data = signal<FileData | null>(null);
  const failure = signal<string | null>(null);
  const body = useBody();
  void Files.open(props.link.machine, props.link.path).then(
    (d) => data.set(d),
    (e) => failure.set(reason(e)),
  );
  const name = () => props.link.path.split("/").pop() ?? props.link.path;
  const machineName = () => Herdr.machines().find((m) => m.id === props.link.machine)?.name ?? props.link.machine;
  const full = () => `${props.link.path}${props.link.line ? `:${props.link.line}` : ""}`;
  const head = (): Head => ({
    icon: "file",
    title: props.link.line ? `${name()}:${props.link.line}` : name(),
    sub: shortPath(parentOf(props.link.path) ?? "/", props.cwd),
    full: full(),
    copy: full(),
    out: {
      label: "Open as a tab",
      onPress: () => {
        viewFile(props.link.machine, props.link.path, props.link.line);
        props.onClose();
      },
    },
  });
  return (
    <>
      <PanelHeader head={head()} onClose={props.onClose} />
      <View class="min-h-0 flex-1 p-3" onLayout={body.onLayout}>
        <If when={failure()}>{(m) => <Empty fill icon="alert" title={`Couldn't open ${name()}`} hint={m()} />}</If>
        <If when={data() && body.height() > 0 ? data() : null}>
          {(d) => (
            <FileViewer
              machine={props.link.machine}
              machineName={machineName()}
              data={d()}
              line={props.link.line}
              onBack={props.onClose}
              panelHeight={body.height() - 24}
            />
          )}
        </If>
      </View>
    </>
  );
}

/** A picture fitted to the panel, its pixel size beside its name; one over the thumbnail cap says so and offers its tab. */
function PicturePanel(props: { link: Extract<PanelLink, { kind: "picture" }>; cwd: string; onClose: () => void }) {
  const body = useBody();
  const size = signal<{ width: number; height: number } | null>(null);
  const key = thumbKey(props.link.machine, "", props.link.path);
  if (!props.link.uri) void loadThumb(props.link.machine, "", props.link.path);
  const uri = () => {
    if (props.link.uri) return props.link.uri;
    const s = thumbState(key);
    return s.state === "ready" ? s.uri : null;
  };
  const problem = () => {
    if (props.link.uri) return null;
    const s = thumbState(key);
    if (s.state === "large") return "This picture is too large to show here. Open it as a tab.";
    return s.state === "failed" || s.state === "missing" ? s.message : null;
  };
  const name = () => props.link.path.split("/").pop() ?? props.link.path;
  const folder = () => shortPath(parentOf(props.link.path) ?? "/", props.cwd);
  // What it drew, else what its header states (`pictureDimensions`), so the size shows before the first frame.
  const dims = () => {
    const u = uri();
    return size() ?? (u ? pictureDimensions(u) : undefined);
  };
  const head = (): Head => ({
    icon: "image",
    title: name(),
    sub: [dims() ? `${Math.round(dims()!.width)} × ${Math.round(dims()!.height)}` : "", folder()]
      .filter(Boolean)
      .join(" · "),
    full: props.link.path,
    copy: props.link.path,
    out: {
      label: "Open as a tab",
      onPress: () => {
        viewFile(props.link.machine, props.link.path);
        props.onClose();
      },
    },
  });
  return (
    <>
      <PanelHeader head={head()} onClose={props.onClose} />
      <View class="min-h-0 flex-1 p-3" onLayout={body.onLayout}>
        <If when={problem()}>{(m) => <Empty fill icon="image" title={`Couldn't show ${name()}`} hint={m()} />}</If>
        <If when={uri() && body.height() > 0 ? uri() : null}>
          {(u) => <ImageView url={u()} name={name()} height={body.height() - 24} onSize={(s) => size.set(s)} />}
        </If>
      </View>
    </>
  );
}

/**
 * The side panel of a chat or a terminal (`design/files.md`, "The side panel"): what a pressed link points at, beside the
 * conversation so it stays in view. A web page in the embedded browser (`Browser`), or a file at its line or a picture
 * under one header line (`PanelHeader`). One per surface, replaced by the next link; `Close` or Escape closes it. Escape
 * is the panel's while the pointer is over a file or a picture (a viewer may hold the keyboard) and otherwise only while
 * no text field has the keyboard, so Escape in the message box keeps its own meaning. Over a page, Escape and the page's
 * keys are the browser's: Escape gives the keyboard back to the message box. Never in a terminal, whose program owns
 * Escape and `Ctrl+R` (`escape={false}`): there the browser takes keys only while its address field has them. Beside
 * the content at `LINK_PANEL_WIDTH`; under `snug()` it lies over the content's right edge, as the inspector does.
 */
export function LinkPanelView(props: { panel: LinkPanel; cwd: string; active: boolean; escape?: boolean }) {
  const over = signal(false);
  effect(() => {
    const link = props.panel.link();
    if (link === null) {
      // Closed under the pointer: no leave comes from a view that is gone.
      untracked(() => over.set(false));
      return;
    }
    // Over a page, Escape is the browser's (it gives the keyboard back); left to binding order it would be a race.
    if (!props.active || props.escape === false || (link.kind === "web" && over())) return;
    return keymap.bind("escape", () => props.panel.close(), { when: over() ? "always" : "notEditing" });
  });
  const close = () => props.panel.close();
  // One child per link: a new link makes a new page, tunnel and viewer, and lets go of the old.
  const shown = () => {
    const link = props.panel.link();
    return link ? [link] : [];
  };
  return (
    <If when={props.panel.link()}>
      <View
        accessibilityLabel="Opened link"
        onMouseEnter={() => over.set(true)}
        onMouseLeave={() => over.set(false)}
        style={{ width: LINK_PANEL_WIDTH }}
        class={`min-h-0 border-l border-border bg-background ${snug() ? "absolute bottom-0 right-0 top-0 shadow-lg dark:shadow-none" : "shrink-0"}`}
      >
        <Each of={shown()} key={(link: PanelLink) => link}>
          {(link) => {
            const l = link();
            if (l.kind === "web") {
              return (
                <WebPanel
                  link={l}
                  onClose={close}
                  onLeave={props.escape === false ? undefined : focusComposer}
                  active={props.active && props.escape !== false && over()}
                />
              );
            }
            if (l.kind === "file") return <FilePanel link={l} cwd={props.cwd} onClose={close} />;
            return <PicturePanel link={l} cwd={props.cwd} onClose={close} />;
          }}
        </Each>
      </View>
    </If>
  );
}
