import { announce, computed, signal, Text, View } from "nsh";
import { Sessions } from "herdr-desktop/native";
import type { OptionChoiceView, OptionView } from "herdr-desktop/native";
import { revision } from "../lib/herdr";
import { lowersGuard, RISK_WORDS } from "../lib/session-options";
import { restartable } from "../lib/timer";
import { Btn, Icon, notify, SelectField } from "./kit";

/** How long a risky mode stays waiting for its confirming press. */
const ARM_MS = 4000;

/** The session as it stands, read again at every change. */
const sessionView = (machine: string, id: string) =>
  computed(() => {
    revision();
    return Sessions.view(machine, id) ?? undefined;
  });

/**
 * One setting of a session (the mode, the model, the thinking level) as the agent offers it, with its choices. A choice
 * that lowers the guard (`OptionChoiceView.risk`) is two steps, not one: picking it only asks (`Switch to Full access`
 * with what it does), and the button that follows, pressed within 4 s, switches. Settings change between turns, so the
 * select is off while one runs. Nothing when the agent does not offer `optionId`.
 */
export function SessionOption(props: { machine: string; id: string; optionId: string; label?: string; small?: boolean }) {
  const view = sessionView(props.machine, props.id);
  const option = computed(() => view()?.options.find((o) => o.id === props.optionId));
  const pending = signal<OptionChoiceView | null>(null);
  const arming = restartable();

  const title = (c: OptionChoiceView) => {
    const words = RISK_WORDS[c.risk];
    return words ? `${c.name} · ${words.tag}` : c.name;
  };
  const current = () => option()?.choices.find((c) => c.value === option()?.current);

  async function apply(o: OptionView, c: OptionChoiceView) {
    pending.set(null);
    arming.stop();
    const result = await Sessions.setOption(props.machine, props.id, o.id, c.value).catch((e: unknown) => ({
      kind: "stopped" as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (result.kind === "done") announce(`${o.name}: ${c.name}`);
    else notify(`${o.name} not changed: ${result.message}`, { type: "error" });
  }

  const choose = (o: OptionView, value: string) => {
    const choice = o.choices.find((c) => c.value === value);
    if (!choice || choice.value === o.current) return;
    if (lowersGuard(current()?.risk ?? "none", choice.risk)) {
      pending.set(choice);
      arming.after(ARM_MS, () => pending.set(null));
      announce(`Press Switch to ${choice.name} to confirm: ${RISK_WORDS[choice.risk]?.why ?? "it lowers the guard"}`);
      return;
    }
    void apply(o, choice);
  };

  return (
    <If when={option()}>
      {(o) => (
        <View class="flex-row flex-wrap items-center gap-2">
          <If when={(current()?.risk ?? "none") !== "none"}>
            <Icon name="alert" size={14} tone="warning" />
          </If>
          <SelectField
            small={props.small}
            label={props.small ? undefined : (props.label ?? o().name)}
            name={props.label ?? o().name}
            disabled={view()?.running === true}
            items={o().choices.map((c) => ({ value: c.value, title: title(c) }))}
            value={o().current ?? ""}
            onChange={(value) => choose(o(), value)}
          />
          <If when={pending()}>
            {(c) => (
              <View class="flex-row flex-wrap items-center gap-2">
                <Btn small variant="danger" label={`Switch to ${c().name}`} onPress={() => void apply(o(), c())} />
                <Text class="text-xs text-foreground">{RISK_WORDS[c().risk]?.why ?? "it lowers the guard"}</Text>
              </View>
            )}
          </If>
        </View>
      )}
    </If>
  );
}

/** The option the agent files under `category` (`mode`, `model`), or nothing. */
const byCategory = (machine: string, id: string, category: string) => {
  const view = sessionView(machine, id);
  return computed(() => view()?.options.find((o) => o.category === category)?.id);
};

/**
 * The session's mode (`Full access`, `Plan`...) as a small chip for the composer's bottom row. One that lowers the guard
 * wears a warning glyph and says so in its title; switching to one takes two presses. Nothing when the agent has no modes.
 */
export function SessionModeChip(props: { machine: string; id: string }) {
  const optionId = byCategory(props.machine, props.id, "mode");
  return (
    <If when={optionId()}>
      {(oid) => <SessionOption small machine={props.machine} id={props.id} optionId={oid()} label="Mode" />}
    </If>
  );
}

/** The session's model as a small picker for the composer's bottom row. Nothing when the agent offers no choice of model. */
export function SessionModelPicker(props: { machine: string; id: string }) {
  const optionId = byCategory(props.machine, props.id, "model");
  return (
    <If when={optionId()}>
      {(oid) => <SessionOption small machine={props.machine} id={props.id} optionId={oid()} label="Model" />}
    </If>
  );
}
