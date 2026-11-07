import { announce, Clipboard, effect, openUrl, signal, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { Herdr, Pages } from "herdr-desktop/native";
import type { PageView } from "herdr-desktop/native";
import { pageRequest } from "#lib/files";
import { Btn, Empty, Modal, notify, Spinner } from "#kit";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A page a remote machine serves on its own `localhost` (a dev server an agent started), shown in a dialog. It is
 * reached through a tunnel on the machine's shared ssh connection, bound to this computer's loopback address, which
 * is opened when the dialog opens and closed when it closes (`Pages.open`, `Pages.closePage`). The web view may show
 * `127.0.0.1` only (`nsh.json`), so a link out of the page goes nowhere by itself: `Open in browser` hands the
 * tunnelled address to the system browser (it works while this dialog stays open). Open while `pageRequest()` holds one.
 */
export function WebPage() {
  const page = signal<PageView | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(true);
  const title = signal("");
  const canGoBack = signal(false);
  let view: WebViewRef | undefined;
  let attempt = 0;

  const start = async (machine: string, url: string) => {
    const mine = ++attempt;
    const previous = page();
    page.set(null);
    if (previous) Pages.closePage(previous.id);
    failure.set(null);
    loading.set(true);
    title.set("");
    try {
      const opened = await Pages.open(machine, url);
      if (mine !== attempt) {
        // The dialog was closed or asked for another page while the tunnel was being made.
        Pages.closePage(opened.id);
        return;
      }
      page.set(opened);
      announce(`Opening ${opened.remoteUrl}`);
    } catch (e) {
      if (mine !== attempt) return;
      failure.set(reason(e));
      loading.set(false);
      announce(reason(e));
    }
  };

  effect(() => {
    const request = pageRequest();
    untracked(() => {
      if (request) void start(request.machine, request.url);
    });
  });

  const close = () => {
    attempt++;
    const open = page();
    page.set(null);
    if (open) Pages.closePage(open.id);
    pageRequest.set(null);
  };
  const machineName = () => {
    const id = pageRequest()?.machine;
    return Herdr.machines().find((m) => m.id === id)?.name ?? id ?? "";
  };
  const remote = () => page()?.remoteUrl ?? pageRequest()?.url ?? "";

  return (
    <Modal
      open={pageRequest() !== null}
      huge
      onClose={close}
      title={title() || `Page on ${machineName()}`}
      description={`${remote()} · through ssh, only from this computer`}
      actions={
        <>
          <Btn variant="ghost" label="Back" disabled={!canGoBack()} onPress={() => view?.goBack()} />
          <Btn variant="ghost" label="Reload" disabled={!page()} onPress={() => view?.reload()} />
          <Btn variant="ghost" label="Copy link" onPress={() => void Clipboard.writeText(remote()).then(() => notify("Link copied"))} />
          <Btn
            variant="ghost"
            label="Open in browser"
            disabled={!page()}
            onPress={() => void openUrl(page()?.url ?? "").catch((e) => notify(`Could not open the address: ${reason(e)}`, { type: "error" }))}
          />
          <Btn label="Close" hint="Esc" onPress={close} />
        </>
      }
    >
      <If
        when={failure()}
        else={
          <View class="h-[460px] overflow-hidden rounded-md border border-border bg-card">
            <If when={page()}>
              {(p) => (
                <WebView
                  ref={(ref) => (view = ref)}
                  src={p().url}
                  accessibilityLabel={`Page ${p().remoteUrl} on ${machineName()}`}
                  onLoadStart={() => loading.set(true)}
                  onLoad={() => loading.set(false)}
                  onError={({ message }) => {
                    failure.set(message);
                    loading.set(false);
                  }}
                  onNavigationStateChange={(nav) => {
                    title.set(nav.title);
                    canGoBack.set(nav.canGoBack);
                  }}
                  class="size-full"
                />
              )}
            </If>
            <If when={loading()}>
              <View class="absolute inset-0 items-center justify-center" accessibilityLabel="Opening the page" accessibilityState={{ busy: true }}>
                <Spinner />
              </View>
            </If>
          </View>
        }
      >
        {(message) => (
          <View class="h-[460px] items-center justify-center">
            <Empty fill icon="alert" title="Couldn't open this page" hint={message()}>
              <Btn label="Try again" onPress={() => void start(pageRequest()?.machine ?? "", pageRequest()?.url ?? "")} />
            </Empty>
          </View>
        )}
      </If>
    </Modal>
  );
}
