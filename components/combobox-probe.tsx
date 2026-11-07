import { mount, signal, Text, View } from "nsh";
import { readMetrics } from "#lib/perf";
import { Btn } from "./kit/button";
import { Autocomplete, Combobox, type ComboOption } from "./kit/combo";
import { Modal } from "./kit/modal";
import { PopupRoot } from "./kit/popup-root";
import { ThemeRoot } from "./kit/theme-root";

/**
 * Test entry only (`combobox.test.tsx`): every combobox and autocomplete feature on one page, with the lists a session
 * list has (a few agents, thousands of sessions, tens of thousands for the worst case), and what each one reports.
 */
const COUNT = 5000;
const HOSTS = ["laptop", "build-box", "dev-server", "workstation", "mac-mini", "raspberry-pi", "ci-runner", "nuc"];

export function sessionsOf(n: number): ComboOption<string>[] {
  const out: ComboOption<string>[] = [];
  for (let i = 0; i < n; i++) out.push({ value: `s${i}`, title: `SES-${String(1 + (i % 12)).padStart(2, "0")}-${String(i).padStart(5, "0")}`, hint: `${HOSTS[i % HOSTS.length]} ${i % 97}` });
  return out;
}

const AGENTS: ComboOption<string>[] = [
  { value: "claude", title: "Claude", group: "Local" },
  { value: "omp", title: "OMP", group: "Local" },
  { value: "codex", title: "Codex", group: "Local" },
  { value: "aider", title: "Aider", group: "Local", disabled: true },
  { value: "gemini", title: "Gemini CLI", group: "Cloud", keywords: "google" },
  { value: "cursor", title: "Cursor Agent", group: "Cloud" },
  { value: "creme", title: "Crème Agent" },
];
const MACHINES = ["laptop (lt-01)", "build-box (bb-02)", "dev-server (ds-03)", "workstation (ws-04)", "mac-mini (mm-05)", "raspberry-pi (rp-06)", "ci-runner (ci-07)"];

const log = signal<string[]>([]);
const say = (line: string) => log.set([...log().slice(-9), line]);

const agent = signal("");
const agents = signal<string[]>(["claude"]);
const session = signal("");
const huge = signal("");
const machine = signal("");
const mode = signal("");
const inlineMode = signal("");
const found = signal<ComboOption<string>[]>([]);
const asyncLoading = signal(false);
const asyncValue = signal("");
const metric = signal("");
const dialog = signal(false);
const dialogAgent = signal("");
const BIG = sessionsOf(COUNT);
const HUGE = sessionsOf(50000);

function Probe() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-row gap-4 p-4">
          <View class="w-80 gap-3">
            <Combobox label="Agent" placeholder="Select agent" items={AGENTS} value={agent()} onChange={(v) => agent.set(v)} onClear={() => agent.set("")} onItemHighlighted={(o, d) => say(`hl:${o?.value ?? "-"}:${d.reason}`)} />
            <Combobox multiple label="Multiple agents" placeholder="Select agent" items={AGENTS} value={agents()} onChange={(v) => agents.set(v)} clear />
            <Combobox label="Session" placeholder="Select session" items={BIG} value={session()} onChange={(v) => session.set(v)} />
            <Combobox label="Session (50,000)" placeholder="Select session" items={HUGE} value={huge()} onChange={(v) => huge.set(v)} />
            <Combobox label="Read only" readOnly items={AGENTS} value="claude" onChange={() => say("readonly-change")} />
            <Combobox label="Locked" disabled items={AGENTS} value="codex" onChange={() => say("disabled-change")} />
            <Combobox
              label="Search on server"
              placeholder="Type to search"
              items={found()}
              filter={null}
              loading={asyncLoading()}
              value={asyncValue()}
              onChange={(v) => asyncValue.set(v)}
              onInputChange={(text, reason) => {
                if (reason !== "type") return;
                asyncLoading.set(true);
                // The server takes two seconds, long enough for a test to see the list say it is loading.
                setTimeout(() => {
                  found.set(text ? BIG.filter((s) => s.title.includes(text.toUpperCase())).slice(0, 20) : []);
                  asyncLoading.set(false);
                }, 2000);
              }}
            />
            <Btn label="Metrics" onPress={() => metric.set(readMetrics().find((m) => m.id === "combobox.list")?.text ?? "")} />
            <Btn label="Open dialog" onPress={() => dialog.set(true)} />
          </View>
          <View class="w-80 gap-3">
            <Autocomplete label="Machine" value={machine()} onChange={(v) => machine.set(v)} suggestions={MACHINES} onPick={(s) => say(`pick:${s.text}`)} />
            <Autocomplete label="Machine (both)" mode="both" value={mode()} onChange={(v) => mode.set(v)} suggestions={MACHINES} />
            <Autocomplete label="Machine (inline)" mode="inline" value={inlineMode()} onChange={(v) => inlineMode.set(v)} suggestions={MACHINES} />
            <Autocomplete label="Machine (empty)" empty="No machines" value={machine()} onChange={(v) => machine.set(v)} suggestions={MACHINES} />
            <Combobox inline label="Open list" items={MACHINES.map((p) => ({ value: p, title: `Open: ${p}` }))} value="" onChange={(v) => say(`inline:${v}`)} />
          </View>
          <View class="w-72 gap-1">
            <Text testID="log" class="text-xs text-muted-foreground">{log().join(" | ")}</Text>
            <Text class="text-xs text-muted-foreground">{`agent:${agent()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`agents:${agents().join(",")}`}</Text>
            <Text class="text-xs text-muted-foreground">{`session:${session()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`huge:${huge()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`machine:${machine()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`mode:${mode()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`async:${asyncValue()}`}</Text>
            <Text class="text-xs text-muted-foreground">{`metric:${metric()}`}</Text>
          </View>
        </View>
        <Modal open={dialog()} onClose={() => dialog.set(false)} title="Dialog" actions={<Btn label="Close" onPress={() => dialog.set(false)} />}>
          <View class="gap-3">
            <Combobox label="Agent in dialog" items={AGENTS} value={dialogAgent()} onChange={(v) => dialogAgent.set(v)} />
            <Text class="text-xs text-muted-foreground">{`dialog:${dialogAgent()}`}</Text>
          </View>
        </Modal>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Probe);
