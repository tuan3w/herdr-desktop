import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import {
  Accordion,
  AccordionItem,
  Avatar,
  CheckRow,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  createCheckGroup,
  Progress,
  RadioGroup,
  RadioItem,
  Segmented,
  Switch,
  TabBar,
  TabItem,
  TabPanel,
  ThemeRoot,
} from "./kit";

type Tab = "one" | "two" | "three";
const ITEMS = ["m1", "m2", "m3", "m4"];

/** A field whose text lives in the component: a panel that is unmounted loses it, a kept one does not. */
function Draft(props: { name: string }) {
  const text = signal("");
  return <Input value={text()} onChange={({ value }) => text.set(value)} accessibilityLabel={props.name} class="h-8 border border-input px-2" />;
}

/** Test entry of `controls.test.tsx` only: every control of the family with a text readout of its value, in a fixed order of Tab stops. */
function Probe() {
  const seg = signal<"a" | "b" | "c">("a");
  const manual = signal<Tab>("one");
  const auto = signal<Tab>("one");
  const runtime = signal("local");
  const ticked = signal(false);
  const asked = signal(0);
  const group = createCheckGroup({ all: () => ITEMS, defaultValue: ["m1"], disabled: (v) => v === "m4" });
  const on = signal(false);
  const folded = signal(false);
  const working = signal(false);
  return (
    <ThemeRoot>
      <View class="flex-1 flex-row gap-6 bg-background p-4">
        <View class="flex-1 gap-3">
        <Segmented
          label="Mode"
          value={seg()}
          onChange={(v) => seg.set(v)}
          options={[
            { value: "a", label: "One" },
            { value: "b", label: "Two" },
            { value: "c", label: "Three" },
          ]}
        />
        <Text>{`seg=${seg()}`}</Text>

        <TabBar label="Manual">
          <TabItem label="First" selected={manual() === "one"} onSelect={() => manual.set("one")} />
          <TabItem label="Second" selected={manual() === "two"} onSelect={() => manual.set("two")} />
          <TabItem label="Third" disabled selected={manual() === "three"} onSelect={() => manual.set("three")} />
        </TabBar>
        <Text>{`manual=${manual()}`}</Text>

        <TabBar label="Automatic" activateOnFocus>
          <TabItem label="Green" selected={auto() === "one"} onSelect={() => auto.set("one")} count={3} spoken="3 items" />
          <TabItem label="Red" selected={auto() === "two"} onSelect={() => auto.set("two")} />
          <TabItem label="Yellow" selected={auto() === "three"} onSelect={() => auto.set("three")} />
        </TabBar>
        <Text>{`auto=${auto()}`}</Text>
        <TabPanel selected={auto() === "one"} keepMounted>
          <Draft name="kept" />
        </TabPanel>
        <TabPanel selected={auto() === "two"}>
          <Draft name="unkept" />
        </TabPanel>
        <RadioGroup label="Runtime" value={runtime()} onChange={(v) => runtime.set(v)} orientation="vertical">
          <RadioItem value="local" label="Local machine" class="h-8 px-2">
            <Text>Local machine</Text>
          </RadioItem>
          <RadioItem value="cloud" label="Cloud sandbox" disabled class="h-8 px-2">
            <Text>Cloud sandbox</Text>
          </RadioItem>
          <RadioItem value="remote" label="Remote machine" class="h-8 px-2">
            <Text>Remote machine</Text>
          </RadioItem>
        </RadioGroup>
        <Text>{`runtime=${runtime()}`}</Text>
        </View>
        <View class="flex-1 gap-3">
        <CheckRow label="Approved" checked={ticked()} onChange={(c) => (asked.update((n) => n + 1), ticked.set(c))}>
          <Text>Approved</Text>
        </CheckRow>
        <Text>{`ticked=${ticked()} asked=${asked()}`}</Text>
        <CheckRow label="Read only" readOnly checked={false} onChange={() => asked.update((n) => n + 100)} />
        <CheckRow label="Locked" disabled checked={false} onChange={() => asked.update((n) => n + 1000)} />

        <CheckRow
          label="Select all"
          checked={group.parent.checked()}
          indeterminate={group.parent.indeterminate()}
          onChange={() => group.parent.press()}
        />
        <Each of={ITEMS} key={(v: string) => v}>
          {(v) => <CheckRow label={v()} disabled={v() === "m4"} checked={group.has(v())} onChange={(c) => group.toggle(v(), c)} />}
        </Each>
        <Text>{`picked=${group.value().join(",")}`}</Text>

        <Switch label="Enable" checked={on()} onChange={(v) => on.set(v)} />
        <Text>{`on=${on()}`}</Text>
        <Switch label="Read only on" readOnly checked={on()} onChange={(v) => on.set(v)} />

        <Collapsible open={folded()} onOpenChange={(open) => folded.set(open)}>
          <CollapsibleTrigger label="Details" chevron>
            <Text>Details</Text>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <Text>detail body</Text>
          </CollapsiblePanel>
        </Collapsible>

        <Accordion defaultValue={["x"]}>
          <AccordionItem value="x">
            <CollapsibleTrigger label="Item X" chevron>
              <Text>Item X</Text>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <Text>body x</Text>
            </CollapsiblePanel>
          </AccordionItem>
          <AccordionItem value="y">
            <CollapsibleTrigger label="Item Y" chevron>
              <Text>Item Y</Text>
            </CollapsibleTrigger>
            <CollapsiblePanel keepMounted>
              <Text>body y</Text>
            </CollapsiblePanel>
          </AccordionItem>
        </Accordion>

        <Progress value={40} label="Progress" valueText="2/5 tasks done" />
        <CheckRow label="Test run" checked={working()} onChange={(c) => working.set(c)} />
        <If when={working()}>
          <Progress value={null} label="Loading" />
        </If>
        <Avatar fallback="CC" label="Claude Code" />
        </View>
      </View>
    </ThemeRoot>
  );
}

mount(Probe);
