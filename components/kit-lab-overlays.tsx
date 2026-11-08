import { host, type JSX, mount, Scroll, signal, Text, View, windowSize } from "nsh";

import {
  Btn,
  CardPreview,
  Field,
  FieldRow,
  Icon,
  type MenuEntry,
  MenuPreview,
  Modal,
  PaletteDialog,
  placeBubble,
  PopoverDescription,
  PopoverPreview,
  PopoverTitle,
  PopupRoot,
  ThemeRoot,
  TipContent,
  TipPreview,
  TipText,
  ToastPreview,
} from "#kit";

/**
 * Test entry, not the app: every overlay of the kit in the cases of its edge-case matrix, one part per launch
 * (`host.params.part`, the `kit-overlays-*` scenarios of `.shots/scenarios.ts`). The host's window screenshot does not draw
 * an overlay (menus, tooltips, popovers, cards, toasts), so those are drawn in place by the kit's `*Preview` parts, which
 * share the real popup's surface and rows, and each is captioned "inline: not the real popup". Dialogs are real `Modal`s
 * and `PaletteDialog`s: the screenshot draws them.
 */
const params = host.params as { part?: string; fixture?: string };
// `part` from a scenario; `fixture` from `shots-mac.mjs --entry <file> --fixture <part>`, which passes no other parameter.
const part = params.part ?? (params.fixture && params.fixture !== "mixed" ? params.fixture : "menus");
const noop = () => {};
const act = (label: string, more: Partial<Extract<MenuEntry, { onSelect: () => void }>> = {}): MenuEntry => ({
  label,
  onSelect: noop,
  ...more,
});

function Caption(props: { text: string }) {
  return <Text class="text-xs text-muted-foreground">{props.text}</Text>;
}

function Case(props: { title: string; inline?: boolean; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      <Caption text={props.inline === false ? props.title : `${props.title} · inline: not the real popup`} />
      {props.children}
    </View>
  );
}

const FIVE: MenuEntry[] = [
  act("Rename", { icon: "pencil", shortcut: "mod+r" }),
  act("Duplicate", { icon: "copy" }),
  {
    type: "group",
    label: "Open in",
    items: [act("Terminal", { icon: "terminal" }), act("Editor", { disabled: true, reason: "No editor set" })],
  },
  { type: "checkbox", label: "Show finished", checked: true, onCheckedChange: noop },
  "separator",
  {
    type: "radio",
    label: "Context",
    value: "12",
    onValueChange: noop,
    items: [
      { label: "3 lines", value: "3" },
      { label: "12 lines", value: "12" },
      { label: "Whole file", value: "all" },
    ],
  },
  { label: "Move to", icon: "folder", items: [act("payments"), act("web")] },
  "separator",
  act("Close 3 agents…", { icon: "trash", danger: true }),
];

const KEYS: MenuEntry[] = [
  act("Accelerator only", { accelerator: "a" }),
  act("Shortcut only", { shortcut: "mod+shift+n" }),
  act("Both: the letter wins", { accelerator: "b", shortcut: "mod+b" }),
  act("Neither"),
  act("Disabled with shortcut", { shortcut: "mod+d", disabled: true }),
];

const SOME_ICONS: MenuEntry[] = [
  act("Open", { icon: "external-link" }),
  act("No icon here"),
  act("Copy path", { icon: "copy" }),
  act("Also none"),
];

const LONG: MenuEntry[] = [
  act("Short"),
  act("averyveryverylonglabelwithnospacesthatmustbecutsomewhereatthemaximumwidth"),
  act("Add a note on this change", { icon: "pencil", shortcut: "c" }),
];

const WORLD: MenuEntry[] = [
  act("重命名会话", { icon: "pencil" }),
  act("セッションを閉じる"),
  act("🚀 Deploy to staging 🎉", { icon: "send" }),
  act("إعادة تسمية الجلسة"),
  act("שנה שם להפעלה"),
  act("Ünïcödé àccents", { shortcut: "mod+u" }),
];

const DISABLED: MenuEntry[] = [
  act("Open in editor", { icon: "external-link", disabled: true, reason: "No editor set" }),
  act("Stop agent", { icon: "pause", disabled: true, reason: "Offline" }),
  act("Mark reviewed", { icon: "check" }),
  "separator",
  act("Revert this change…", { icon: "undo", danger: true, disabled: true, reason: "No changes" }),
  act("Revert this file…", { icon: "trash", danger: true }),
];

const FORTY: MenuEntry[] = Array.from({ length: 40 }, (_, i) => act(`Agent ${String(i + 1).padStart(2, "0")}`));

function Menus() {
  return (
    <Scroll class="flex-1" contentClass="flex-row flex-wrap items-start gap-6 p-6">
      <Case title="1 item">
        <MenuPreview entries={[act("Open", { icon: "external-link" })]} />
      </Case>
      <Case title="Groups, check, radio, submenu, disabled reason, danger; Rename highlighted">
        <MenuPreview entries={FIVE} highlight={0} />
      </Case>
      <Case title="Accelerator, shortcut, both">
        <MenuPreview entries={KEYS} highlight={2} />
      </Case>
      <Case title="Icons on some rows">
        <MenuPreview entries={SOME_ICONS} />
      </Case>
    </Scroll>
  );
}

function MenusMore() {
  return (
    <Scroll class="flex-1" contentClass="flex-row flex-wrap items-start gap-6 p-6">
      <Case title="Long label, no spaces">
        <MenuPreview entries={LONG} />
      </Case>
      <Case title="CJK, emoji, RTL">
        <MenuPreview entries={WORLD} highlight={3} />
      </Case>
      <Case title="Disabled with reasons; danger highlighted">
        <MenuPreview entries={DISABLED} highlight={5} />
      </Case>
      <Case title="40 items (scrolls past 368: the last row shows half)">
        <MenuPreview entries={FORTY} highlight={0} />
      </Case>
    </Scroll>
  );
}

const SPOTS: { name: string; x: number; y: number }[] = [
  { name: "top left", x: 0, y: 0 },
  { name: "top", x: 0.5, y: 0 },
  { name: "top right", x: 1, y: 0 },
  { name: "left", x: 0, y: 0.5 },
  { name: "right", x: 1, y: 0.5 },
  { name: "bottom left", x: 0, y: 1 },
  { name: "bottom", x: 0.5, y: 1 },
  { name: "bottom right", x: 1, y: 1 },
];

/** Tooltip placement near every edge: an anchor (a 32 pt button) in each spot and its bubble where `placeBubble` puts it. */
function Edges() {
  const win = () => windowSize();
  const anchor = (s: { x: number; y: number }) => ({
    x: Math.round(s.x * (win().width - 32 - 16)) + 8,
    y: Math.round(s.y * (win().height - 32 - 16)) + 8,
    width: 32,
    height: 32,
  });
  return (
    <View class="flex-1">
      <View class="absolute inset-0 items-center justify-center">
        <Caption text="Tooltips placed by placeBubble near each edge (8 pt margin) · inline: not the real popup" />
      </View>
      <Each of={SPOTS}>
        {(spot) => {
          const a = () => anchor(spot());
          const long = spot().name.startsWith("bottom");
          const width = long ? 240 : 120;
          const height = long ? 40 : 24;
          const at = () => placeBubble({ anchor: a(), bubble: { width, height }, window: win() });
          return (
            <>
              <View
                style={{ position: "absolute", left: a().x, top: a().y, width: 32, height: 32 }}
                class="items-center justify-center rounded-md bg-accent"
              >
                <Icon name="ellipsis" tone="muted-foreground" />
              </View>
              {/* The host lines the real bubble up by `align` with its measured size: an end-aligned one shares the anchor's right edge. */}
              <View
                style={{
                  position: "absolute",
                  top: at().y,
                  maxWidth: at().width,
                  ...(at().align === "end"
                    ? { right: win().width - a().x - a().width, alignItems: "flex-end" as const }
                    : { left: at().align === "start" ? a().x : at().x }),
                }}
              >
                <TipPreview>
                  {long ? (
                    <TipText>{`Near the ${spot().name}: a long tooltip that wraps at the bubble's width`}</TipText>
                  ) : (
                    <TipText>{`Near the ${spot().name}`}</TipText>
                  )}
                </TipPreview>
              </View>
            </>
          );
        }}
      </Each>
    </View>
  );
}

function Floating() {
  return (
    <Scroll class="flex-1" contentClass="flex-row flex-wrap items-start gap-8 p-6">
      <View class="gap-6">
        <Case title="Tooltip, short">
          <TipPreview>
            <TipText>Split right</TipText>
          </TipPreview>
        </Case>
        <Case title="Tooltip with a shortcut">
          <TipPreview>
            <TipContent label="New agent session" shortcut="mod+n" />
          </TipPreview>
        </Case>
        <Case title="Tooltip, long text wraps at 240">
          <TipPreview>
            <TipText>Ask a quick side question without adding it to the session or interrupting the agent</TipText>
          </TipPreview>
        </Case>
        <Case title="Popover">
          <PopoverPreview class="w-68">
            <PopoverTitle>Display</PopoverTitle>
            <PopoverDescription>What the sidebar shows for each agent</PopoverDescription>
            <Btn label="Compact rows" variant="ghost" onPress={noop} />
          </PopoverPreview>
        </Case>
        <Case title="Preview card">
          <CardPreview>
            <Text class="text-sm font-medium text-popover-foreground">src/payments/refund.ts</Text>
            <Text class="text-xs text-muted-foreground">+48 −12 · modified 2 min ago by payments review</Text>
          </CardPreview>
        </Case>
      </View>
      <View class="gap-3">
        <Case title="Toasts: one each">
          <ToastPreview text="Saved" />
          <ToastPreview text="Closed Notes" undo />
          <ToastPreview text="Could not save the file" type="error" stays />
          <ToastPreview text="Could not reach build-box" type="warning" stays />
          <ToastPreview text="Sending message" type="loading" />
          <ToastPreview text="The agent stopped because its machine went offline, so the change was not applied. Start it again from the sidebar once the machine is back." />
        </Case>
        <Case title="Five at once: three show, two wait (limit 3)">
          <ToastPreview text="Notice three" />
          <ToastPreview text="Notice four" />
          <ToastPreview text="Notice five" />
        </Case>
      </View>
    </Scroll>
  );
}

const LOREM =
  "The agent stopped because its machine went offline. Its folder and its branch stay as they were, and nothing that was sent to it is lost. ";

function Dialogs() {
  const open = signal(true);
  const child = signal(true);
  const close = () => open.set(false);
  const actions2 = (verb: string, danger = false) => (
    <>
      <Btn variant="ghost" label="Cancel" onPress={close} />
      <Btn variant={danger ? "danger" : "primary"} label={verb} onPress={close} />
    </>
  );
  const body = () => {
    switch (part) {
      case "dialog-small":
        return (
          <Modal
            open={open()}
            onClose={close}
            size="small"
            title="Send 3 notes to api-fix?"
            actions={actions2("Send 3 notes")}
          />
        );
      case "dialog-title":
        return (
          <Modal
            open={open()}
            onClose={close}
            title="Close 3 agents in payments, web and the very long project name that keeps going past one line?"
            description="Stops 3 agents and discards 2 unsent prompts. Their folders stay."
            actions={
              <>
                <Btn variant="ghost" label="Copy list" onPress={close} />
                <Btn variant="ghost" label="Cancel" onPress={close} />
                <Btn variant="danger" label="Close 3 agents" onPress={close} />
              </>
            }
          />
        );
      case "dialog-scroll":
        return (
          <Modal open={open()} onClose={close} title="What happened" actions={actions2("Start again")}>
            <View class="gap-3">
              <Each of={Array.from({ length: 14 }, (_, i) => i)}>
                {(i) => <Text class="text-sm text-card-foreground">{`${i() + 1}. ${LOREM}`}</Text>}
              </Each>
            </View>
          </Modal>
        );
      case "dialog-none":
        return (
          <Modal open={open()} onClose={close} size="small" title="About Herdr Desktop">
            <Text class="text-sm text-muted-foreground">Version 0.1.0 · 3 machines</Text>
          </Modal>
        );
      case "dialog-form":
        return (
          <Modal
            open={open()}
            onClose={close}
            title="Add machine"
            description="A computer you reach with ssh."
            disablePointerDismissal
            actions={actions2("Add machine")}
          >
            <View class="gap-3">
              <FieldRow>
                <Field label="Name *" value="" onChange={noop} error="Give it a name." reserve />
              </FieldRow>
              <FieldRow>
                <Field
                  label="Destination *"
                  value="me@build box"
                  onChange={noop}
                  error="A destination has no spaces: user@host."
                  reserve
                />
              </FieldRow>
            </View>
          </Modal>
        );
      case "dialog-stack":
        return (
          <>
            <Modal
              open={open()}
              onClose={close}
              title="Edit machine"
              description="build-box · ssh me@build-box"
              actions={actions2("Save")}
            >
              <Btn variant="danger" label="Remove machine…" onPress={() => child.set(true)} />
            </Modal>
            <Modal
              open={child()}
              onClose={() => child.set(false)}
              size="small"
              title="Remove build-box?"
              description="Stops 2 agents on it. Their folders stay on the machine."
              actions={
                <>
                  <Btn variant="ghost" label="Cancel" onPress={() => child.set(false)} />
                  <Btn variant="danger" label="Remove machine" onPress={() => child.set(false)} />
                </>
              }
            />
          </>
        );
      case "dialog-settings":
        return (
          <Modal
            open={open()}
            onClose={close}
            size="settings"
            title="Settings"
            actions={<Btn variant="ghost" label="Close" onPress={close} />}
          >
            <View class="flex-1 flex-row">
              <View class="w-48 gap-1 border-r border-border p-2">
                <Each of={["General", "Look", "Machines", "Notifications", "Shortcuts", "About"]}>
                  {(name) => (
                    <View class="h-8 justify-center rounded-md px-3">
                      <Text class="text-sm text-foreground">{name()}</Text>
                    </View>
                  )}
                </Each>
              </View>
              <Scroll class="flex-1" contentClass="gap-3 p-6">
                <Each of={Array.from({ length: 24 }, (_, i) => i)}>
                  {(i) => <Text class="text-sm text-card-foreground">{`Setting ${i() + 1}`}</Text>}
                </Each>
              </Scroll>
            </View>
          </Modal>
        );
      default:
        return (
          <Palette count={part === "palette-0" ? 0 : part === "palette-1" ? 1 : 500} long={part === "palette-long"} />
        );
    }
  };
  return (
    <View class="flex-1 gap-2 p-6">
      <Caption text={`${part}: real dialog`} />
      <Text class="text-sm text-foreground">The page behind the dialog, so the scrim has something to dim.</Text>
      {body()}
    </View>
  );
}

/** The palette's frame (`PaletteDialog`) with stand-in content: a query line and N rows. The real palette is `components/palette.tsx`. */
function Palette(props: { count: number; long: boolean }) {
  const query = props.long
    ? "refund webhook retries that fail after the third attempt on the payments staging machine"
    : props.count === 0
      ? "zzz"
      : "agent";
  const rows = Array.from({ length: props.count }, (_, i) => `Agent ${String(i + 1).padStart(3, "0")} · payments`);
  return (
    <PaletteDialog open onClose={noop}>
      <View class="h-12 flex-row items-center gap-3 border-b border-border px-4">
        <Icon name="search" tone="muted-foreground" />
        <Text class="line-clamp-1 min-w-0 flex-1 text-base text-popover-foreground">{query}</Text>
      </View>
      <If when={props.count > 0}>
        <Scroll class="min-h-0 shrink" contentClass="p-1">
          <Each of={rows}>
            {(row, i) => (
              <View class={`h-8 justify-center rounded-md px-3 ${i() === 0 ? "bg-accent" : ""}`}>
                <Text class="text-sm text-popover-foreground">{row()}</Text>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
      <If when={props.count === 0}>
        <View class="p-4">
          <Text class="text-sm text-muted-foreground">{`No match for “${query}”`}</Text>
        </View>
      </If>
    </PaletteDialog>
  );
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        {part === "menus" ? (
          <Menus />
        ) : part === "menus-more" ? (
          <MenusMore />
        ) : part === "edges" ? (
          <Edges />
        ) : part === "floating" ? (
          <Floating />
        ) : (
          <Dialogs />
        )}
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
