import { host, type JSX, mount, Scroll, signal, Text, View } from "nsh";

import { FolderField } from "#components/folder-field";
import {
  Autocomplete,
  Btn,
  CheckRow,
  Combobox,
  type ComboOption,
  Field,
  IconButton,
  NumberField,
  PopupRoot,
  RadioGroup,
  RadioItem,
  SearchField,
  Segmented,
  SelectField,
  Switch,
  ThemeRoot,
} from "#kit";
import { startHerdr } from "#lib/herdr";
import { largeTargets } from "#lib/settings";

/**
 * The inputs and controls of the kit, every component in every case of the edge-case matrix at once (`.shots/scenarios.ts`
 * `kit-inputs-*`): states are drawn by props, never by presses, since a Mac screenshot cannot press. `host.params.fixture` is
 * the page (`buttons`, `fields`, `numbers`, `selects`, `select-open`, `combos`, `combo-open`, `toggles`); `large` raises
 * every control to the Large hit targets tier. Synthetic data only. Not part of the app.
 */
startHerdr("", "mixed");
const params = host.params as { fixture?: string; large?: boolean };
const page = typeof params.fixture === "string" ? params.fixture : "buttons";
if (params.large) largeTargets.set(true);

const noop = () => undefined;
/** 300 characters, no space: a path that cannot wrap. */
const PATH = `/home/someone/workspace/${"payments-service-with-a-very-long-folder-name-".repeat(6)}`.slice(0, 300);
const CJK = "支付服务的代码审查与部署";
const EMOJI = "🚀 Deploy 🔥 build ✅ done";
const RTL = "مراجعة خدمة الدفع";
const LONG_LABEL = "The folder on the machine where the agent starts, its working tree and its branch";
const ERR3 =
  "This folder does not exist on build-box-eu-west-2. Check the spelling, or create it first with mkdir, then try again: the agent starts in this exact folder and cannot create it.";

function Case(props: { caption: string; width?: 240 | 440; children?: JSX.Element }) {
  return (
    <View class={`gap-1 ${props.width === 240 ? "w-[240px]" : props.width === 440 ? "w-[440px]" : "w-[300px]"}`}>
      <Text class="text-xs text-muted-foreground opacity-70">{props.caption}</Text>
      <View class="flex-row">{props.children}</View>
    </View>
  );
}
function Section(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-3">
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <View class="flex-row flex-wrap gap-x-6 gap-y-4">{props.children}</View>
    </View>
  );
}

function Buttons() {
  return (
    <>
      <Section title="Btn: variants">
        <Case caption="primary">
          <Btn variant="primary" label="Start agent" onPress={noop} />
        </Case>
        <Case caption="outline (default)">
          <Btn label="Browse" onPress={noop} />
        </Case>
        <Case caption="ghost">
          <Btn variant="ghost" label="Cancel" onPress={noop} />
        </Case>
        <Case caption="danger">
          <Btn variant="danger" label="Close pane" onPress={noop} />
        </Case>
      </Section>
      <Section title="Btn: disabled">
        <Case caption="primary disabled">
          <Btn variant="primary" label="Start agent" hint="↵" disabled onPress={noop} />
        </Case>
        <Case caption="outline disabled">
          <Btn label="Browse" icon="plus" disabled onPress={noop} />
        </Case>
        <Case caption="ghost disabled">
          <Btn variant="ghost" label="Cancel" disabled onPress={noop} />
        </Case>
        <Case caption="danger disabled">
          <Btn variant="danger" label="Close pane" disabled onPress={noop} />
        </Case>
      </Section>
      <Section title="Btn: loading (busy, keeps width)">
        <Case caption="primary loading">
          <Btn variant="primary" label="Start agent" loading onPress={noop} />
        </Case>
        <Case caption="outline loading, small">
          <Btn label="Test connection" small loading onPress={noop} />
        </Case>
        <Case caption="ghost loading with icon">
          <Btn variant="ghost" icon="refresh" label="Refresh" loading onPress={noop} />
        </Case>
        <Case caption="danger loading">
          <Btn variant="danger" label="Remove" loading onPress={noop} />
        </Case>
      </Section>
      <Section title="Btn: icon, keycaps, small">
        <Case caption="icon + label">
          <Btn icon="plus" label="New agent" onPress={noop} />
        </Case>
        <Case caption="label + keycaps (primary)">
          <Btn variant="primary" label="Send" hint="mod+enter" onPress={noop} />
        </Case>
        <Case caption="label + keycaps (outline)">
          <Btn label="Search" hint="mod+k" onPress={noop} />
        </Case>
        <Case caption="small: primary, outline, ghost">
          <View class="flex-row gap-2">
            <Btn small variant="primary" label="Save" onPress={noop} />
            <Btn small icon="copy" label="Copy" onPress={noop} />
            <Btn small variant="ghost" label="Skip" hint="esc" onPress={noop} />
          </View>
        </Case>
      </Section>
      <Section title="Btn: long label in narrow containers">
        <Case caption="240 wide, long label" width={240}>
          <Btn label="Open the folder on build-box-eu-west-2 in a new pane" onPress={noop} />
        </Case>
        <Case caption="240 wide, long label + icon + keys" width={240}>
          <Btn variant="primary" icon="plus" label="Start a new agent session here" hint="mod+n" onPress={noop} />
        </Case>
        <Case caption="440 wide, one row of three" width={440}>
          <View class="min-w-0 flex-1 flex-row justify-end gap-2">
            <Btn variant="ghost" label="Cancel" onPress={noop} />
            <Btn label="Test connection" onPress={noop} />
            <Btn variant="primary" label="Save machine" hint="↵" onPress={noop} />
          </View>
        </Case>
        <Case caption="CJK, emoji">
          <View class="flex-row gap-2">
            <Btn label={CJK} onPress={noop} />
            <Btn variant="ghost" label="🚀 Ship" onPress={noop} />
          </View>
        </Case>
      </Section>
      <Section title="IconButton">
        <Case caption="rest, selected, disabled, roomy">
          <View class="flex-row items-center gap-2">
            <IconButton icon="plus" label="New agent" onPress={noop} />
            <IconButton icon="ellipsis" label="More" selected onPress={noop} />
            <IconButton icon="trash" label="Delete" disabled onPress={noop} />
            <IconButton icon="sliders" label="Settings" roomy onPress={noop} />
          </View>
        </Case>
        <Case caption="beside a 32 default Btn (one row, one height?)">
          <View class="flex-row items-center gap-2">
            <Btn label="Open" onPress={noop} />
            <IconButton icon="ellipsis" label="More" onPress={noop} />
            <IconButton icon="copy" label="Copy" roomy onPress={noop} />
          </View>
        </Case>
        <Case caption="beside a small Btn">
          <View class="flex-row items-center gap-2">
            <Btn small label="Open" onPress={noop} />
            <IconButton icon="ellipsis" label="More" onPress={noop} />
          </View>
        </Case>
      </Section>
    </>
  );
}

function Fields() {
  const typed = signal("payments-api");
  return (
    <>
      <Section title="Field: label">
        <Case caption="short label, focused (autoFocus)" width={240}>
          <Field label="Name" autoFocus value={typed()} onChange={(v) => typed.set(v)} />
        </Case>
        <Case caption="very long label, 240" width={240}>
          <Field label={LONG_LABEL} value="" placeholder="/home/you/project" onChange={noop} />
        </Case>
        <Case caption="no label, placeholder names it" width={240}>
          <Field label="" value="" placeholder="Notes for the agent" onChange={noop} />
        </Case>
        <Case caption="required" width={240}>
          <Field label="Machine *" required value="" placeholder="Name or host" onChange={noop} />
        </Case>
      </Section>
      <Section title="Field: value">
        <Case caption="one char" width={240}>
          <Field label="Branch" value="x" onChange={noop} />
        </Case>
        <Case caption="300-char path, mono, 240" width={240}>
          <Field label="Folder" mono value={PATH} onChange={noop} />
        </Case>
        <Case caption="300-char path, 440" width={440}>
          <Field label="Folder" mono value={PATH} onChange={noop} />
        </Case>
        <Case caption="CJK" width={240}>
          <Field label="Title" value={CJK} onChange={noop} />
        </Case>
        <Case caption="emoji" width={240}>
          <Field label="Title" value={EMOJI} onChange={noop} />
        </Case>
        <Case caption="RTL" width={240}>
          <Field label="Title" value={RTL} onChange={noop} />
        </Case>
        <Case caption="masked" width={240}>
          <Field label="Token" masked value="hunter2-synthetic" onChange={noop} />
        </Case>
      </Section>
      <Section title="Field: hint, error, reserve">
        <Case caption="hint" width={240}>
          <Field label="Port" value="22" hint="Leave empty for 22." onChange={noop} />
        </Case>
        <Case caption="error, short" width={240}>
          <Field label="Machine *" value="" error="Choose a machine." onChange={noop} />
        </Case>
        <Case caption="error, three lines, 240" width={240}>
          <Field label="Folder *" mono value="/srv/missing" error={ERR3} onChange={noop} />
        </Case>
        <Case caption="reserve, no error (room kept)" width={240}>
          <View class="flex-1 gap-2">
            <Field label="Machine *" reserve value="" onChange={noop} />
            <Text class="text-xs text-muted-foreground">next line</Text>
          </View>
        </Case>
        <Case caption="reserve, with error" width={240}>
          <View class="flex-1 gap-2">
            <Field label="Machine *" reserve value="" error="Choose a machine." onChange={noop} />
            <Text class="text-xs text-muted-foreground">next line</Text>
          </View>
        </Case>
        <Case caption="invalid, no message" width={240}>
          <Field label="Host" invalid value="bad host" onChange={noop} />
        </Case>
      </Section>
      <Section title="Field: disabled, read-only, multiline">
        <Case caption="disabled, with value" width={240}>
          <Field label="Machine" disabled value="build-box" onChange={noop} />
        </Case>
        <Case caption="disabled, empty" width={240}>
          <Field label="Machine" disabled value="" placeholder="Name or host" onChange={noop} />
        </Case>
        <Case caption="read-only" width={240}>
          <Field label="Pane id" mono readOnly value="w3:p12" onChange={noop} />
        </Case>
        <Case caption="multiline with text" width={440}>
          <Field
            label="Prompt"
            multiline
            value={"Review the payments diff.\nFocus on the retry path and the idempotency key."}
            onChange={noop}
          />
        </Case>
      </Section>
      <Section title="SearchField">
        <Case caption="empty" width={240}>
          <SearchField value="" placeholder="Search agents" onChange={noop} />
        </Case>
        <Case caption="with value (clear button)" width={240}>
          <SearchField value="payments" placeholder="Search agents" onChange={noop} />
        </Case>
        <Case caption="dense, empty and long value" width={240}>
          <View class="flex-1 gap-2">
            <SearchField dense value="" placeholder="Filter files" onChange={noop} />
            <SearchField dense value={PATH} placeholder="Filter files" onChange={noop} />
          </View>
        </Case>
      </Section>
    </>
  );
}

function Numbers() {
  return (
    <>
      <Section title="NumberField">
        <Case caption="value, steppers on focus (autoFocus)" width={240}>
          <NumberField label="Port" autoFocus defaultValue={2222} min={1} max={65535} />
        </Case>
        <Case caption="at min (minus off)" width={240}>
          <NumberField label="Retries" defaultValue={0} min={0} max={10} />
        </Case>
        <Case caption="at max" width={240}>
          <NumberField label="Retries" defaultValue={10} min={0} max={10} />
        </Case>
        <Case caption="negative" width={240}>
          <NumberField label="Offset" defaultValue={-42} />
        </Case>
        <Case caption="decimals, unit" width={240}>
          <NumberField label="Delay" defaultValue={1.25} step={0.25} unit="s" />
        </Case>
        <Case caption="1,234.5 (as pasted, formatted)" width={240}>
          <NumberField label="Budget" defaultValue={1234.5} />
        </Case>
        <Case caption="empty, placeholder" width={240}>
          <NumberField label="Lines" placeholder="Unlimited" />
        </Case>
        <Case caption="error" width={240}>
          <NumberField label="Port" defaultValue={70000} allowOutOfRange max={65535} error="Enter 65,535 or less." />
        </Case>
        <Case caption="disabled" width={240}>
          <NumberField label="Port" defaultValue={22} disabled />
        </Case>
        <Case caption="read-only" width={240}>
          <NumberField label="Port" defaultValue={22} readOnly />
        </Case>
        <Case caption="long label, hint, unit" width={240}>
          <NumberField label={LONG_LABEL} defaultValue={12} unit="lines" hint="How much context to keep." />
        </Case>
        <Case caption="huge number" width={240}>
          <NumberField label="Bytes" defaultValue={123456789012345} />
        </Case>
      </Section>
      <Section title="One row, one height: Field + NumberField + Select + Btn">
        <Case caption="default tier, bottom aligned" width={440}>
          <View class="min-w-0 flex-1 flex-row items-end gap-2">
            <Field label="Host" value="build-box" onChange={noop} />
            <NumberField label="Port" defaultValue={22} steppers={false} />
            <SelectField label="Agent" value="claude" items={AGENTS} onChange={noop} />
            <Btn label="Add" onPress={noop} />
          </View>
        </Case>
      </Section>
    </>
  );
}

const AGENTS = [
  { value: "claude", title: "Claude Code" },
  { value: "codex", title: "Codex" },
  { value: "gemini", title: "Gemini CLI" },
  { value: "opencode", title: "OpenCode" },
  { value: "amp", title: "Amp" },
  { value: "aider", title: "Aider" },
  { value: "goose", title: "Goose" },
  { value: "cursor", title: "Cursor agent" },
];
const MANY = Array.from({ length: 500 }, (_, i) => ({
  value: `m${i}`,
  title: `build-box-${String(i).padStart(3, "0")}`,
}));
const LONGS = [
  { value: "a", title: "build-box-eu-west-2 (staging cluster, shared with the payments team)" },
  { value: "b", title: PATH },
  { value: "c", title: CJK },
  { value: "d", title: RTL },
];

function Selects() {
  return (
    <>
      <Section title="SelectField: options">
        <Case caption="0 options" width={240}>
          <SelectField label="Agent" value="" items={[]} onChange={noop} />
        </Case>
        <Case caption="1 option, chosen" width={240}>
          <SelectField label="Agent" value="claude" items={AGENTS.slice(0, 1)} onChange={noop} />
        </Case>
        <Case caption="8 options, placeholder" width={240}>
          <SelectField label="Agent" value="" placeholder="Choose an agent" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="500 options, chosen" width={240}>
          <SelectField label="Machine" value="m321" items={MANY} onChange={noop} />
        </Case>
        <Case caption="value not in the list" width={240}>
          <SelectField label="Agent" value="ghost-agent" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="long value, 240" width={240}>
          <SelectField label="Machine" value="a" items={LONGS} onChange={noop} />
        </Case>
        <Case caption="300-char value, 440" width={440}>
          <SelectField label="Folder" value="b" items={LONGS} onChange={noop} />
        </Case>
        <Case caption="CJK / RTL" width={240}>
          <View class="flex-1 gap-2">
            <SelectField label="Title" value="c" items={LONGS} onChange={noop} />
            <SelectField label="Title" value="d" items={LONGS} onChange={noop} />
          </View>
        </Case>
      </Section>
      <Section title="SelectField: states">
        <Case caption="no label (name only)" width={240}>
          <SelectField name="Agent" value="codex" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="long label" width={240}>
          <SelectField label={LONG_LABEL} value="codex" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="required, empty" width={240}>
          <SelectField label="Agent *" required value="" placeholder="Choose an agent" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="invalid" width={240}>
          <SelectField label="Agent" invalid value="" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="error, three lines" width={240}>
          <SelectField label="Agent *" value="" error={ERR3} items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="hint without a label" width={240}>
          <SelectField name="Agent" value="codex" hint="The program the agent runs." items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="disabled" width={240}>
          <SelectField label="Agent" disabled value="claude" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="read-only" width={240}>
          <SelectField label="Agent" readOnly value="claude" items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="multiple, three chosen" width={240}>
          <SelectField label="Agents" multiple value={["claude", "codex", "gemini"]} items={AGENTS} onChange={noop} />
        </Case>
        <Case caption="small beside a small Btn" width={240}>
          <View class="flex-1 flex-row items-center gap-2">
            <View class="min-w-0 flex-1">
              <SelectField small name="State" value="claude" items={AGENTS} onChange={noop} />
            </View>
            <Btn small label="Apply" onPress={noop} />
          </View>
        </Case>
      </Section>
    </>
  );
}

function SelectOpen() {
  return (
    <Section title="SelectField: open lists">
      <Case caption="500 options open on the value" width={240}>
        <SelectField label="Machine" defaultOpen value="m321" items={MANY} onChange={noop} />
      </Case>
      <View class="w-[260px]" />
      <Case caption="long options open" width={240}>
        <SelectField label="Machine" defaultOpen alignItemWithTrigger={false} value="a" items={LONGS} onChange={noop} />
      </Case>
      <View class="w-[260px]" />
      <Case caption="0 options open" width={240}>
        <SelectField label="Agent" defaultOpen value="" items={[]} onChange={noop} />
      </Case>
    </Section>
  );
}

const MACHINES: ComboOption<string>[] = [
  { value: "local", title: "This computer", hint: "macOS" },
  { value: "box", title: "build-box-eu-west-2", hint: "ssh · staging" },
  { value: "gpu", title: "gpu-runner", hint: "ssh · training", group: "Remote" },
  { value: "cjk", title: CJK, hint: "ssh", group: "Remote" },
  { value: "off", title: "old-mac-mini", hint: "offline", disabled: true, group: "Remote" },
  ...LONGS.map((l) => ({ value: `l${l.value}`, title: l.title })),
];

function Combos() {
  return (
    <>
      <Section title="Combobox">
        <Case caption="chosen" width={240}>
          <Combobox label="Machine" value="box" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="empty, placeholder" width={240}>
          <Combobox label="Machine" value="" placeholder="Name or host" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="long chosen value (one line)" width={240}>
          <Combobox label="Machine" value="la" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="300-char value, clear button" width={240}>
          <Combobox label="Folder" value="lb" items={MACHINES} onChange={noop} onClear={noop} />
        </Case>
        <Case caption="value not in items" width={240}>
          <Combobox label="Machine" value="vanished" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="error" width={240}>
          <Combobox label="Machine *" value="" items={MACHINES} error="Choose a machine." onChange={noop} />
        </Case>
        <Case caption="disabled" width={240}>
          <Combobox label="Machine" disabled value="box" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="read-only" width={240}>
          <Combobox label="Machine" readOnly value="box" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="small" width={240}>
          <Combobox label="Machine" small value="box" items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="no label, hint" width={240}>
          <Combobox name="Machine" value="gpu" hint="Where the agent runs." items={MACHINES} onChange={noop} />
        </Case>
      </Section>
      <Section title="Combobox multiple">
        <Case caption="three chips" width={240}>
          <Combobox label="Machines" multiple value={["local", "box", "gpu"]} items={MACHINES} onChange={noop} clear />
        </Case>
        <Case caption="long chips, 440" width={440}>
          <Combobox label="Machines" multiple value={["la", "lb", "cjk", "ld"]} items={MACHINES} onChange={noop} />
        </Case>
        <Case caption="maxChips 2 (+N)" width={240}>
          <Combobox
            label="Machines"
            multiple
            maxChips={2}
            value={["local", "box", "gpu", "cjk"]}
            items={MACHINES}
            onChange={noop}
          />
        </Case>
      </Section>
      <Section title="Autocomplete, FolderField">
        <Case caption="value" width={240}>
          <Autocomplete label="Host" value="build-box" suggestions={["build-box", "gpu-runner"]} onChange={noop} />
        </Case>
        <Case caption="long value, clear" width={240}>
          <Autocomplete label="Host" clear mono value={PATH} suggestions={[]} onChange={noop} />
        </Case>
        <Case caption="error, three lines" width={240}>
          <Autocomplete label="Host *" value="" error={ERR3} suggestions={[]} onChange={noop} />
        </Case>
        <Case caption="disabled" width={240}>
          <Autocomplete label="Host" disabled value="build-box" suggestions={[]} onChange={noop} />
        </Case>
        <Case caption="FolderField (inactive: no listing)" width={240}>
          <FolderField
            label="Folder *"
            machine="local"
            value={PATH}
            recents={[]}
            active={false}
            required
            reserve
            onChange={noop}
          />
        </Case>
        <Case caption="FolderField empty, placeholder, hint" width={240}>
          <FolderField
            label="Folder"
            machine="local"
            value=""
            recents={[]}
            active={false}
            placeholder="/home/you/project"
            hint="An absolute folder."
            onChange={noop}
          />
        </Case>
      </Section>
    </>
  );
}

function ComboOpen() {
  return (
    <Section title="Combobox open">
      <Case caption="open with hints and groups" width={240}>
        <Combobox label="Machine" defaultOpen value="box" items={MACHINES} onChange={noop} />
      </Case>
      <View class="w-[400px]" />
      <Case caption="open, 500 options, limit 50" width={240}>
        <Combobox label="Machine" defaultOpen limit={50} value="" items={MANY} onChange={noop} />
      </Case>
    </Section>
  );
}

const SIX = [
  { value: "a", label: "All" },
  { value: "n", label: "Needs you" },
  { value: "w", label: "Working" },
  { value: "d", label: "Done" },
  { value: "i", label: "Idle" },
  { value: "o", label: "Offline" },
] as const;

function Toggles() {
  const radio = signal<string | undefined>("ssh");
  return (
    <>
      <Section title="CheckRow">
        <Case caption="unchecked, checked, mixed">
          <View class="gap-1">
            <CheckRow label="Notify" checked={false} onChange={noop}>
              <Text class="text-sm text-foreground">Notify</Text>
            </CheckRow>
            <CheckRow label="Notify" checked onChange={noop}>
              <Text class="text-sm text-foreground">Notify</Text>
            </CheckRow>
            <CheckRow label="Select all" checked={false} indeterminate onChange={noop}>
              <Text class="text-sm text-foreground">Select all</Text>
            </CheckRow>
          </View>
        </Case>
        <Case caption="disabled, read-only, invalid">
          <View class="gap-1">
            <CheckRow label="Locked" disabled checked onChange={noop}>
              <Text class="text-sm text-foreground">Locked (disabled)</Text>
            </CheckRow>
            <CheckRow label="Read only" readOnly checked onChange={noop}>
              <Text class="text-sm text-foreground">Read only</Text>
            </CheckRow>
            <CheckRow label="I agree" required invalid checked={false} onChange={noop}>
              <Text class="text-sm text-foreground">I agree (required, invalid)</Text>
            </CheckRow>
          </View>
        </Case>
        <Case caption="long label, 240" width={240}>
          <CheckRow label={LONG_LABEL} checked onChange={noop}>
            <Text class="text-sm text-foreground">{LONG_LABEL}</Text>
          </CheckRow>
        </Case>
        <Case caption="300-char path, 240" width={240}>
          <CheckRow label={PATH} checked={false} onChange={noop}>
            <Text class="text-sm text-foreground">{PATH}</Text>
          </CheckRow>
        </Case>
        <Case caption="string child, CJK, emoji" width={240}>
          <View class="gap-1">
            <CheckRow label={CJK} checked onChange={noop}>
              <Text class="text-sm text-foreground">{CJK}</Text>
            </CheckRow>
            <CheckRow label={EMOJI} checked={false} onChange={noop}>
              <Text class="text-sm text-foreground">{EMOJI}</Text>
            </CheckRow>
          </View>
        </Case>
        <Case caption="bare box (label only)">
          <CheckRow label="Select all" checked onChange={noop} />
        </Case>
      </Section>
      <Section title="Switch">
        <Case caption="off, on">
          <View class="flex-row items-center gap-4">
            <Switch label="Notifications" checked={false} onChange={noop} />
            <Switch label="Notifications" checked onChange={noop} />
          </View>
        </Case>
        <Case caption="disabled off/on, read-only, invalid">
          <View class="flex-row items-center gap-4">
            <Switch label="A" disabled checked={false} onChange={noop} />
            <Switch label="B" disabled checked onChange={noop} />
            <Switch label="C" readOnly checked onChange={noop} />
            <Switch label="D" required invalid checked={false} onChange={noop} />
          </View>
        </Case>
        <Case caption="in a row with long text, 240" width={240}>
          <View class="min-w-0 flex-1 flex-row items-center gap-3">
            <Text class="min-w-0 flex-1 text-sm text-foreground">{LONG_LABEL}</Text>
            <Switch label="Long" checked onChange={noop} />
          </View>
        </Case>
      </Section>
      <Section title="Segmented">
        <Case caption="2 options">
          <Segmented
            label="Theme"
            value="l"
            onChange={noop}
            options={[
              { value: "l", label: "Light" },
              { value: "d", label: "Dark" },
            ]}
          />
        </Case>
        <Case caption="icon only">
          <Segmented
            label="View"
            iconOnly
            value="l"
            onChange={noop}
            options={[
              { value: "l", label: "List", icon: "list" },
              { value: "c", label: "Columns", icon: "columns" },
            ]}
          />
        </Case>
        <Case caption="icon + label">
          <Segmented
            label="Mode"
            value="s"
            onChange={noop}
            options={[
              { value: "s", label: "Light", icon: "sun" },
              { value: "m", label: "Dark", icon: "moon" },
              { value: "y", label: "System", icon: "monitor" },
            ]}
          />
        </Case>
        <Case caption="6 options, 440" width={440}>
          <Segmented label="Filter" value="n" onChange={noop} options={[...SIX]} />
        </Case>
        <Case caption="6 options, 240" width={240}>
          <Segmented label="Filter" value="n" onChange={noop} options={[...SIX]} />
        </Case>
        <Case caption="long label, 240" width={240}>
          <Segmented
            label="Diff"
            value="u"
            onChange={noop}
            options={[
              { value: "u", label: "Unified, one column" },
              { value: "s", label: "Side by side, two columns" },
            ]}
          />
        </Case>
      </Section>
      <Section title="RadioGroup">
        <Case caption="vertical, long and disabled item" width={240}>
          <RadioGroup label="Connect with" value={radio()} onChange={(v) => radio.set(v)} class="gap-1">
            <RadioItem value="ssh" label="ssh" class="min-h-7 flex-row items-center gap-2 rounded-md px-2">
              <Text class="text-sm text-foreground">ssh (chosen)</Text>
            </RadioItem>
            <RadioItem value="local" label="local" class="min-h-7 flex-row items-center gap-2 rounded-md px-2">
              <Text class="min-w-0 flex-1 text-sm text-foreground">{LONG_LABEL}</Text>
            </RadioItem>
            <RadioItem value="off" label="off" disabled class="min-h-7 flex-row items-center gap-2 rounded-md px-2">
              <Text class="text-sm text-foreground">Disabled item</Text>
            </RadioItem>
          </RadioGroup>
        </Case>
      </Section>
    </>
  );
}

const PAGES: Record<string, () => JSX.Element> = {
  buttons: Buttons,
  fields: Fields,
  numbers: Numbers,
  selects: Selects,
  "select-open": SelectOpen,
  combos: Combos,
  "combo-open": ComboOpen,
  toggles: Toggles,
};

mount(() => {
  const Page = PAGES[page] ?? Buttons;
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <Scroll class="flex-1">
          <View class="gap-6 p-6">
            <Text class="text-xs text-muted-foreground">{`kit inputs: ${page}${params.large ? " · large targets" : ""}`}</Text>
            <Page />
          </View>
        </Scroll>
      </PopupRoot>
    </ThemeRoot>
  );
});
