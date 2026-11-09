import { announce, Clipboard, effect, keymap, openUrl, signal, Text, untracked, View, WebView } from "nsh";
import { Input } from "nsh/base";

import type { InputRef, WebViewNavigation, WebViewRef } from "nsh/types";

import { Btn, Clipped, Empty, IconButton, INPUT_CLASS, notify, Progress } from "#kit";
import { addressParts, refusedNote, swapOrigin, type Via, webAddress } from "#lib/browser";
import { BAR } from "#lib/layout";
import { keyText } from "#lib/shortcuts";

/**
 * Runs before each page's own scripts, in its top frame. A sound or a video that starts without the person's press or key
 * in the second before is paused, so nothing plays by itself. A link or `window.open` that asks for a new window opens in
 * place: nsh's web view has no second window (WebKitGTK is given no `create` handler, so such a link would do nothing).
 */
const PAGE_SCRIPT = `(() => {
  let touched = 0;
  const mark = () => { touched = Date.now(); };
  addEventListener("pointerdown", mark, true);
  addEventListener("keydown", mark, true);
  addEventListener("play", (e) => {
    const media = e.target;
    if (Date.now() - touched > 1000 && media && typeof media.pause === "function") media.pause();
  }, true);
  addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("a[target]") : null;
    if (link && !["", "_self", "_top", "_parent"].includes(link.target)) link.target = "_self";
  }, true);
  window.open = (url) => {
    if (url !== undefined && url !== "") location.assign(String(url));
    return null;
  };
})();`;

const START: WebViewNavigation = { url: "", title: "", loading: true, canGoBack: false, canGoForward: false };

export interface BrowserProps {
  /** The address it opens, as the person knows it. Read once: a new address is a new `Browser`. */
  url: string;
  /** Loads through a tunnel: the page is fetched at `via.local` and shown, copied and typed as `via.remote`. */
  via?: Via;
  /** The caller is still making the way to the page (a tunnel): nothing loads yet, the loading line runs. */
  waiting?: boolean;
  /** Muted after the address at rest: where the page runs (`devbox · through ssh`). */
  place?: string;
  /** The caller could not make the way to the page; shown as the page's own failure, `Try again` calls `onRetry`. */
  failure?: string | null;
  onRetry?: () => void;
  /** `Close` at the toolbar's end. */
  onClose?: () => void;
  /** Escape from the browser gives the keyboard back here (the chat's message box). Without it Escape stays the surface's. */
  onLeave?: () => void;
  /**
   * The browser may take its keys (`mod+L`, `mod+[`, `mod+]`, `mod+R`, Escape) now. The page holding the keyboard is not
   * reported by nsh, so the caller says when it is likely (the pointer over it); the focused address field takes them anyway.
   */
  active?: boolean;
}

/**
 * The embedded browser (`design/files.md`, "The side panel"): a toolbar one `BAR` high (Back, Forward, Reload or Stop,
 * the address, Copy link, Open in browser, Close), a 2 pt line under it while a page loads, and the page, which the
 * person clicks, types into and scrolls (WebKit takes the pointer and the keyboard natively; nsh's `webview.input` is
 * only for scripted input, which this does not use). What loads is decided twice: the address field takes https and
 * loopback http (`webAddress`), and nsh refuses every navigation its `webview` capability does not grant (only http and
 * https), which a page link to `mailto:` or `file:` meets; nothing is downloaded (no `onDownload` listener, and WebKitGTK
 * then ignores what it cannot show). One that fails says what happened, with `Try again` and `Open in browser`.
 */
export function Browser(props: BrowserProps) {
  const nav = signal<WebViewNavigation>(START);
  /** What the web view loads (a tunnel's local address); `null` before the caller has one. */
  const src = signal<string | null>(null);
  /** Remounts the web view: `Try again` after a failure loads fresh instead of asking WebKit to reload a page it never had. */
  const mount = signal(0);
  const failed = signal<{ url: string; message: string } | null>(null);
  /** The last address that finished loading: what a failure covers, and what Back returns to from it. */
  const loaded = signal("");
  const editing = signal(false);
  let web: WebViewRef | undefined;
  let field: InputRef | undefined;

  const local = (url: string) => {
    const v = props.via;
    return v ? swapOrigin(url, v.remote, v.local) : url;
  };
  const shown = (url: string) => {
    const v = props.via;
    return v ? swapOrigin(url, v.local, v.remote) : url;
  };
  effect(() => {
    if (!props.waiting && untracked(src) === null) src.set(local(untracked(() => props.url)));
  });

  /** The address loaded now (or being loaded), before any tunnel swap. */
  const current = () => nav().url || src() || "";
  const address = () => (src() === null ? props.url : shown(current()));
  const loading = () => props.waiting === true || (src() !== null && nav().loading && failed() === null);
  const failure = () => props.failure ?? failed()?.message ?? null;
  const canOpen = () => src() !== null && !props.failure;
  const host = () => {
    const f = failed();
    return addressParts(f?.url ? shown(f.url) : address()).host;
  };

  const go = (url: string) => {
    const load = local(url);
    if (load === loaded() && !failed()) web?.reload();
    else if (load !== src()) src.set(load);
    else if (loaded() === "") {
      // Nothing ever loaded (the first load failed): a fresh web view, rather than asking WebKit to reload no page.
      mount.update((n) => n + 1);
      nav.set(START);
    }
    // `src` already names it (the page went elsewhere, or this very load failed): the page is asked to go there.
    else web?.injectJavaScript(`location.assign(${JSON.stringify(load)})`);
    failed.set(null);
    nav.update((n) => ({ ...n, url: load, loading: true }));
  };
  const back = () => {
    // A failed load never became a history entry: the page before it is still there under the failure.
    if (failed() && loaded()) nav.update((n) => ({ ...n, url: loaded(), loading: false }));
    else web?.goBack();
    failed.set(null);
  };
  const canBack = () => nav().canGoBack || (failed() !== null && loaded() !== "");
  const forward = () => {
    failed.set(null);
    web?.goForward();
  };
  const reload = () => {
    if (failed()) retry();
    else web?.reload();
  };
  const retry = () => {
    if (props.failure) props.onRetry?.();
    else go(shown(failed()?.url || current()));
  };
  const browse = () => {
    // A tunnelled page opens in the browser at its local address, which works while the tunnel stands.
    void openUrl(current())
      .then(({ opened }) => {
        if (!opened) notify("Nothing on this computer opens that address", { type: "error" });
      })
      .catch((e) =>
        notify(`Could not open the address: ${e instanceof Error ? e.message : String(e)}`, { type: "error" }),
      );
  };
  const submit = (typed: string): boolean => {
    const result = webAddress(typed);
    if ("error" in result) {
      notify(result.error, { type: "error" });
      return false;
    }
    go(result.url);
    return true;
  };
  const leave = () => {
    field?.blur();
    props.onLeave?.();
  };

  effect(() => {
    if (!editing() && !props.active) return;
    const keys: Record<string, () => void> = {
      "mod+l": () => {
        field?.focus();
        field?.setSelection(0, address().length);
      },
      "mod+r": reload,
    };
    // Bound only when they can act, so the app's own Back and Forward (the same keys) keep working otherwise.
    if (canBack()) keys["mod+["] = back;
    if (nav().canGoForward) keys["mod+]"] = forward;
    if (editing() || props.onLeave) keys.escape = leave;
    return keymap.bind(keys, { when: "always" });
  });

  return (
    <View class="min-h-0 flex-1">
      <View
        role="toolbar"
        accessibilityLabel="Page controls"
        style={{ minHeight: BAR }}
        class="shrink-0 flex-row items-center gap-1 border-b border-border px-2"
      >
        <IconButton icon="arrow-left" label="Back" shortcut={keyText("mod+[")} disabled={!canBack()} onPress={back} />
        <IconButton
          icon="arrow-right"
          label="Forward"
          shortcut={keyText("mod+]")}
          disabled={!nav().canGoForward}
          onPress={forward}
        />
        <If
          when={loading() && src() !== null}
          else={
            <IconButton
              icon="rotate-cw"
              label="Reload"
              shortcut={keyText("mod+r")}
              disabled={src() === null}
              onPress={reload}
            />
          }
        >
          <IconButton icon="x" label="Stop loading" onPress={() => web?.stopLoading()} />
        </If>
        <AddressField
          url={address()}
          place={props.place}
          title={nav().title}
          onSubmit={submit}
          onEditing={(on) => editing.set(on)}
          inputRef={(node) => (field = node)}
        />
        <IconButton
          icon="copy"
          label="Copy link"
          onPress={() => void Clipboard.writeText(address()).then(() => notify("Link copied"))}
        />
        <IconButton icon="external-link" label="Open in browser" disabled={!canOpen()} onPress={browse} />
        <If when={props.onClose}>
          <IconButton icon="x" label="Close" onPress={() => props.onClose?.()} />
        </If>
      </View>
      <View class="min-h-0 flex-1">
        <If when={src()}>
          {(load) => (
            <Each of={[mount()]} key={(n: number) => n}>
              {() => (
                <WebView
                  ref={(node: WebViewRef) => {
                    web = node;
                  }}
                  src={load()}
                  accessibilityLabel={`Page ${address()}`}
                  injectedJavaScriptBeforeContentLoaded={PAGE_SCRIPT}
                  onLoadStart={(n) => nav.set(n)}
                  onLoad={(n) => {
                    nav.set(n);
                    loaded.set(n.url);
                  }}
                  onNavigationStateChange={(n) => nav.set(n)}
                  onError={(e) => {
                    const to = "url" in e && typeof e.url === "string" ? e.url : "";
                    // Refused once a page was asked for (a `mailto:` link, a frame of `data:`): what shows stays as it was.
                    if (e.code === "ERR_ACCESS_DENIED" && nav().url !== "") {
                      const note = refusedNote(to);
                      if (note) notify(note, { type: "error" });
                      return;
                    }
                    failed.set({ url: to || current(), message: e.message });
                    nav.update((n) => ({ ...n, loading: false }));
                    announce(`Couldn't load ${host()}: ${e.message}`);
                  }}
                  class="size-full"
                />
              )}
            </Each>
          )}
        </If>
        <If when={failure()}>
          {(message) => (
            <View class="absolute inset-0 bg-background">
              <Empty fill icon="alert" title={`Couldn't load ${host()}`} hint={message()}>
                <View class="flex-row gap-2">
                  <Btn label="Try again" onPress={retry} />
                  <Btn label="Open in browser" variant="ghost" disabled={!canOpen()} onPress={browse} />
                </View>
              </Empty>
            </View>
          )}
        </If>
        <If when={loading()}>
          {/* Over the page's top edge, so the page never moves when a load starts or ends. */}
          <View class="absolute left-0 right-0 top-0 h-0.5 overflow-hidden">
            <Progress value={null} label={`Loading ${addressParts(address()).host}`} />
          </View>
        </If>
      </View>
    </View>
  );
}

/**
 * The address: the kit's bare input look, the whole address while it has the keyboard, and at rest the host in the
 * normal colour with the rest muted after it (and `place`, where the page runs), so the host is what is read first. Enter
 * goes (`onSubmit` says whether it did; a refusal keeps the text to fix); leaving the field drops what was typed.
 */
function AddressField(props: {
  url: string;
  place?: string;
  title: string;
  onSubmit: (typed: string) => boolean;
  onEditing: (on: boolean) => void;
  inputRef: (node: InputRef) => void;
}) {
  const focused = signal(false);
  const typed = signal<string | null>(null);
  let input: InputRef | undefined;
  const parts = () => addressParts(props.url);
  return (
    <View class="mx-1 min-w-0 flex-1">
      <Input
        ref={(node: InputRef) => {
          input = node;
          props.inputRef(node);
        }}
        value={typed() ?? props.url}
        onChange={({ value }) => typed.set(value)}
        accessibilityLabel="Address"
        accessibilityHint={props.title || undefined}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        submitBehavior="submit"
        onSubmit={({ text }) => {
          if (!props.onSubmit(text)) return;
          typed.set(null);
          input?.blur();
        }}
        onFocus={() => {
          focused.set(true);
          props.onEditing(true);
        }}
        onBlur={() => {
          focused.set(false);
          typed.set(null);
          props.onEditing(false);
        }}
        class={`${INPUT_CLASS} ${focused() ? "" : "text-transparent"}`}
      />
      <If when={!focused()}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          class="pointer-events-none absolute inset-px flex-row items-center gap-2 px-3"
        >
          <Clipped
            tip={false}
            label={`${parts().lead}${parts().host}${parts().rest}`}
            fade={["from-card/0 to-card"]}
            boxClass="min-w-0 shrink"
            class="text-sm text-muted-foreground"
          >
            {parts().lead}
            <Text class="text-foreground">{parts().host}</Text>
            {parts().rest}
          </Clipped>
          <If when={props.place}>
            <Text style={{ numberOfLines: 1 }} class="max-w-[45%] shrink-0 text-xs text-muted-foreground">
              {props.place}
            </Text>
          </If>
        </View>
      </If>
    </View>
  );
}
