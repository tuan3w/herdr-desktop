import { Files, Herdr, Pages } from "herdr-desktop/native";
import { announce, cleanup, Clipboard, effect, keymap, openUrl, signal, untracked, View, WebView } from "nsh";

import type { FileData, PageView } from "herdr-desktop/native";

import { FileViewer } from "#components/file-viewer";
import { ImageView } from "#components/image-view";
import { Btn, Clipped, Empty, Icon, IconButton, type IconName, notify, snug, Spinner } from "#kit";
import { loadThumb, pictureDimensions, thumbKey, thumbState } from "#lib/chat-pictures";
import { parentOf } from "#lib/files";
import { BAR } from "#lib/layout";
import { LINK_PANEL_WIDTH, type LinkPanel, type PanelLink } from "#lib/link-panel";
import { shortUrl } from "#lib/links";
import { viewFile } from "#lib/open-files";
import { shortPath } from "#lib/session-text";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs before a page's own scripts: a sound or a video that starts without the person's press or key in the second before
 * is paused, so nothing in the panel plays by itself. The page gets nothing it did not have; this only takes away.
 */
const NO_AUTOPLAY = `(() => {
  let touched = 0;
  const mark = () => { touched = Date.now(); };
  addEventListener("pointerdown", mark, true);
  addEventListener("keydown", mark, true);
  addEventListener("play", (e) => {
    const media = e.target;
    if (Date.now() - touched > 1000 && media && typeof media.pause === "function") media.pause();
  }, true);
})();`;

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
  /** `Open in browser` (web) or `Open as a tab` (a file or a picture). */
  out: { label: string; onPress: () => void; disabled?: boolean };
}

const copyLink = (text: string) => void Clipboard.writeText(text).then(() => notify("Link copied"));

/** One `BAR`-high line, as the chat's header: the kind's glyph, the title, where it is, and the panel's actions. */
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
      <IconButton icon="copy" label="Copy link" onPress={() => copyLink(props.head.copy)} />
      <Btn
        small
        variant="ghost"
        icon="external-link"
        label={props.head.out.label}
        disabled={props.head.out.disabled}
        onPress={props.head.out.onPress}
      />
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
 * A web page. One of this computer is loaded as it is; a page of a remote machine's own `localhost` is reached through a
 * tunnel on its shared ssh connection, bound to this computer's loopback address, made when the panel shows it and
 * removed when it closes or shows something else (`Pages.open`, `Pages.closePage`). The page gets nothing but its load
 * (no input, no messages, no downloads listened to) and plays nothing by itself (`NO_AUTOPLAY`). One that fails says
 * what happened and offers the browser.
 */
function WebPanel(props: { link: Extract<PanelLink, { kind: "web" }>; onClose: () => void }) {
  const page = signal<PageView | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(true);
  const title = signal("");
  let attempt = 0;
  const tunnelled = props.link.machine !== undefined;

  const start = async () => {
    const mine = ++attempt;
    const previous = page();
    page.set(null);
    if (previous && tunnelled) Pages.closePage(previous.id);
    failure.set(null);
    loading.set(true);
    title.set("");
    if (!tunnelled) {
      page.set({ id: 0, url: props.link.url, remoteUrl: props.link.url });
      return;
    }
    try {
      const opened = await Pages.open(props.link.machine!, props.link.url);
      if (mine !== attempt) {
        // The panel closed or showed another link while the tunnel was being made.
        Pages.closePage(opened.id);
        return;
      }
      page.set(opened);
    } catch (e) {
      if (mine !== attempt) return;
      failure.set(reason(e));
      loading.set(false);
      announce(`Couldn't load ${host()}: ${reason(e)}`);
    }
  };
  void start();
  cleanup(() => {
    attempt++;
    const open = page();
    if (open && tunnelled) Pages.closePage(open.id);
  });

  const host = () => shortUrl(props.link.url)?.host ?? props.link.url;
  const machineName = () => Herdr.machines().find((m) => m.id === props.link.machine)?.name ?? props.link.machine ?? "";
  const browse = () =>
    void openUrl(page()?.url ?? props.link.url).catch((e) =>
      notify(`Could not open the address: ${reason(e)}`, { type: "error" }),
    );
  const head = (): Head => ({
    icon: "globe",
    title: title() || host(),
    sub: tunnelled ? `${machineName()} · through ssh` : title() ? host() : "",
    full: props.link.url,
    copy: props.link.url,
    // A tunnelled page opens in the browser only while the tunnel stands, that is while the panel shows it.
    out: { label: "Open in browser", onPress: browse, disabled: tunnelled && page() === null },
  });

  return (
    <>
      <PanelHeader head={head()} onClose={props.onClose} />
      <View class="min-h-0 flex-1">
        <If
          when={failure()}
          else={
            <>
              <If when={page()}>
                {(p) => (
                  <WebView
                    src={p().url}
                    accessibilityLabel={`Page ${props.link.url}`}
                    injectedJavaScriptBeforeContentLoaded={NO_AUTOPLAY}
                    onLoadStart={() => loading.set(true)}
                    onLoad={() => loading.set(false)}
                    onError={({ message }) => {
                      failure.set(message);
                      loading.set(false);
                      announce(`Couldn't load ${host()}: ${message}`);
                    }}
                    onNavigationStateChange={(nav) => title.set(nav.title)}
                    class="size-full"
                  />
                )}
              </If>
              <If when={loading()}>
                <View
                  class="absolute inset-0 items-center justify-center bg-background"
                  accessibilityLabel="Opening the page"
                  accessibilityState={{ busy: true }}
                >
                  <Spinner />
                </View>
              </If>
            </>
          }
        >
          {(message) => (
            <Empty fill icon="alert" title={`Couldn't load ${host()}`} hint={message()}>
              <View class="flex-row gap-2">
                <Btn label="Try again" onPress={() => void start()} />
                <Btn label="Open in browser" variant="ghost" disabled={tunnelled} onPress={browse} />
              </View>
            </Empty>
          )}
        </If>
      </View>
    </>
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
 * conversation so it stays in view. A web page, a file at its line, or a picture, under one header line (`PanelHeader`).
 * One per surface, replaced by the next link; `Close` or Escape closes it. Escape is the panel's while the pointer is
 * over it (a page in it may hold the keyboard) and otherwise only while no text field has the keyboard, so Escape in the
 * message box keeps its own meaning; never in a terminal, whose program owns Escape (`escape={false}`). Beside the
 * content at `LINK_PANEL_WIDTH`; under `snug()` it lies over the content's right edge, as the inspector does.
 */
export function LinkPanelView(props: { panel: LinkPanel; cwd: string; active: boolean; escape?: boolean }) {
  const over = signal(false);
  effect(() => {
    if (props.panel.link() === null) {
      // Closed under the pointer: no leave comes from a view that is gone.
      untracked(() => over.set(false));
      return;
    }
    if (!props.active || props.escape === false) return;
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
            if (l.kind === "web") return <WebPanel link={l} onClose={close} />;
            if (l.kind === "file") return <FilePanel link={l} cwd={props.cwd} onClose={close} />;
            return <PicturePanel link={l} cwd={props.cwd} onClose={close} />;
          }}
        </Each>
      </View>
    </If>
  );
}
