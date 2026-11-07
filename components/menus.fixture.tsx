import { mount, signal, Text, View } from "nsh";
import { ActionMenu, Btn, type MenuEntry, Modal, RowMenu, SelectField, ThemeRoot, PopupRoot } from "./kit";

/** Test entry only: every menu and select feature on one page, so `menus.test.tsx` can drive them without the app's data. */
const MACHINES = Array.from({ length: 500 }, (_, i) => ({ value: `m${i + 1}`, title: `Machine ${String(i + 1).padStart(3, "0")}` }));
const AGENTS = Array.from({ length: 80 }, (_, i) => ({ value: `a${i + 1}`, label: `Agent ${String(i + 1).padStart(3, "0")}` }));

const runs = signal(0);
const finished = signal(false);
const sort = signal("date");
const agent = signal("a1");
const machine = signal("m250");
const machines = signal<string[]>(["m2"]);
const locked = signal("");
const group = signal("lap");
const dialog = signal(false);
const dialogAgent = signal("");

const entries = (): MenuEntry[] => [
  { label: "Open", icon: "copy", shortcut: "⌘O", onSelect: () => runs.set(runs() + 1) },
  { type: "checkbox", label: "Show finished sessions", checked: finished(), onCheckedChange: (checked) => finished.set(checked) },
  {
    type: "radio",
    label: "Sort",
    value: sort(),
    onValueChange: (value) => sort.set(value),
    items: [
      { value: "date", label: "By date" },
      { value: "name", label: "By name" },
      { value: "status", label: "By status" },
    ],
  },
  "separator",
  { type: "group", label: "Columns", items: [{ label: "Pane title", onSelect: () => runs.set(runs() + 10) }] },
  { label: "Locked", disabled: true, onSelect: () => runs.set(runs() + 100) },
  {
    label: "Move to",
    items: [
      { label: "Laptop", onSelect: () => runs.set(runs() + 1000) },
      { label: "Build box", onSelect: () => runs.set(runs() + 1000) },
    ],
  },
  "separator",
  { label: "Delete…", icon: "trash", danger: true, onSelect: () => runs.set(runs() + 10000) },
];

const agentMenu = (): MenuEntry[] => [
  { type: "radio", value: agent(), onValueChange: (value) => agent.set(value), items: AGENTS },
];

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 gap-4 bg-background p-6">
        <View class="flex-row items-center gap-3">
          <ActionMenu label="Display options" entries={entries()} />
          <ActionMenu label="Choose agent" entries={agentMenu()} icon="list" />
          <ActionMenu label="No loop" entries={entries()} loop={false} />
          <ActionMenu label="Open on hover" entries={entries()} openOnHover closeDelay={100} />
        </View>
        <Text class="text-sm text-foreground">{`Runs: ${runs()}`}</Text>
        <Text class="text-sm text-foreground">{`Finished: ${finished() ? "on" : "off"}`}</Text>
        <Text class="text-sm text-foreground">{`Sort: ${sort()}`}</Text>
        <Text class="text-sm text-foreground">{`Agent: ${agent()}`}</Text>
        <Text class="text-sm text-foreground">{`Machine: ${machine()}`}</Text>
        <Text class="text-sm text-foreground">{`Machines: ${machines().join(",")}`}</Text>
        <View class="w-72 gap-3">
          <SelectField label="Target machine" items={MACHINES} value={machine()} onChange={(value) => machine.set(value)} />
          <SelectField label="Machines" multiple items={MACHINES.slice(0, 6)} value={machines()} onChange={(value) => machines.set(value)} />
          <SelectField label="Read only" readOnly items={MACHINES.slice(0, 4)} value={locked() || "m1"} onChange={(value) => locked.set(value)} />
          <SelectField label="Disabled" disabled items={MACHINES.slice(0, 4)} value="m1" onChange={() => {}} />
          <SelectField
            label="Machine group"
            placeholder="Select machine"
            items={[
              { label: "Office", items: [{ value: "lap", title: "Laptop" }, { value: "bb", title: "Build box", disabled: true }, { value: "dev", title: "Dev server" }] },
              "separator",
              { label: "Cloud", items: [{ value: "vm", title: "Cloud VM" }] },
            ]}
            value={group()}
            onChange={(value) => group.set(value)}
          />
        </View>
        <RowMenu entries={entries()}>
          <View class="h-12 justify-center rounded-md border border-border px-3">
            <Text class="text-sm text-foreground">Right-click test row</Text>
          </View>
        </RowMenu>
        <Btn label="Open dialog" onPress={() => dialog.set(true)} />
        <Modal open={dialog()} onClose={() => dialog.set(false)} title="Dialog with a list">
          <SelectField label="Agent in dialog" items={AGENTS.map((c) => ({ value: c.value, title: c.label }))} value={dialogAgent() as string} onChange={(value) => dialogAgent.set(value)} />
        </Modal>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
