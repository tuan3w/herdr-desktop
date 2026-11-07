import { keymap, mount, signal, Text, View } from "nsh";
import { Btn, closeToast, confirmDestructive, focusToasts, Modal, notify, notifyPromise, ThemeRoot, ToastHost, undoLast } from "#kit";

/**
 * The entry of `feedback.test.tsx` and of the screenshots of the toasts and dialogs: one button for each thing a toast or a
 * dialog can do, and a log of what the callers heard. Not part of the app.
 */
const log = signal<string[]>([]);
const say = (line: string) => log.update((all) => [...all, line]);
const undone = signal(0);

function Lab() {
  keymap.bind({ "mod+z": () => undoLast(), "mod+shift+t": () => focusToasts() });
  const a = signal(false);
  const b = signal(false);
  const refusing = signal(false);
  const letGo = signal(false);
  const typed = signal(false);
  const long = signal(false);
  let lines = 0;
  const send = (ok: boolean) => {
    const sent = new Promise<boolean>((resolve) => setTimeout(() => resolve(ok), 20000));
    void notifyPromise(sent, {
      loading: { text: "Sending message", undo: () => say("send undone") },
      success: (delivered) => (delivered ? { text: "Message sent" } : { text: "Could not send message", type: "error", lasting: true }),
      error: () => undefined,
    });
  };
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <View class="flex-row flex-wrap gap-2">
          <Btn label="Plain toast" onPress={() => notify("Saved")} />
          <Btn label="Toast with undo" onPress={() => notify(`Task ${++lines} finished`, { undo: () => undone.update((n) => n + 1) })} />
          <Btn label="Toast five" onPress={() => ["one", "two", "three", "four", "five"].forEach((n) => notify(`Notice ${n}`))} />
          <Btn label="Toast that stays" onPress={() => notify("Read carefully", { timeout: 0 })} />
          <Btn label="Warning toast" onPress={() => notify("Could not save changes", { lasting: true })} />
          <Btn label="Close all" onPress={() => closeToast()} />
          <Btn label="Send message" onPress={() => send(true)} />
          <Btn label="Send failing message" onPress={() => send(false)} />
          <Btn label="Ask twice" onPress={() => void Promise.all([confirmDestructive({ title: "Delete?", description: "This cannot be undone.", action: "Delete" }), confirmDestructive({ title: "Delete?", description: "This cannot be undone.", action: "Delete" })]).then(([first, second]) => say(`confirm ${first} ${second}`))} />
        </View>
        <View class="flex-row flex-wrap gap-2">
          <Btn label="Open A" onPress={() => a.set(true)} />
          <Btn label="Open refusing dialog" onPress={() => refusing.set(true)} />
          <Btn label="Open drafting dialog" onPress={() => typed.set(true)} />
          <Btn label="Open long dialog" onPress={() => long.set(true)} />
        </View>
        <Text class="text-sm text-foreground">{`undone ${undone()}`}</Text>
        <Each of={log()}>{(line) => <Text class="text-xs text-muted-foreground">{line()}</Text>}</Each>
      </View>
      <Modal
        open={a()}
        title="Dialog A"
        onClose={(change) => {
          say(`A ${change.reason}`);
          a.set(false);
        }}
        onOpenChangeComplete={(open) => say(`A ${open ? "opened" : "closed"}`)}
        actions={<Btn label="Open B" onPress={() => b.set(true)} />}
      >
        <Text class="text-sm text-foreground">Content A</Text>
      </Modal>
      <Modal
        open={b()}
        title="Dialog B"
        onClose={(change) => {
          say(`B ${change.reason}`);
          b.set(false);
        }}
        actions={<Btn label="Toast in B" onPress={() => notify("Toast from B")} />}
      >
        <Text class="text-sm text-foreground">Content B</Text>
      </Modal>
      <Modal
        open={refusing()}
        title="Refusing dialog"
        onClose={(change) => {
          say(`refused ${change.reason}`);
          if (letGo()) refusing.set(false);
        }}
        actions={<Btn label="Let go" onPress={() => letGo.set(true)} />}
      >
        <Text class="text-sm text-foreground">The owner will not let it close</Text>
      </Modal>
      <Modal
        open={typed()}
        disablePointerDismissal
        title="Drafting dialog"
        onClose={(change) => {
          say(`drafting ${change.reason}`);
          typed.set(false);
        }}
      >
        <Text class="text-sm text-foreground">A press outside does not close it</Text>
      </Modal>
      <Modal
        open={long()}
        title="Long dialog"
        description="When the content is taller than the window, only the content scrolls."
        onClose={() => long.set(false)}
        actions={<Btn label="Done" onPress={() => long.set(false)} />}
      >
        <View class="gap-2">
          <Each of={Array.from({ length: 60 }, (_, i) => `Row ${i + 1}`)}>{(line) => <Text class="text-sm text-foreground">{line()}</Text>}</Each>
        </View>
      </Modal>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
