import { host, List, mount, Scroll, Text, View, windowSize } from "nsh";
import { DockArea } from "nsh/base";

import { TabChip, tabFrameClass, tabsCompactFor } from "#components/tab-face";
import type { TabBadge, TabKind } from "#components/tab-face";
import {
  Accordion,
  AccordionItem,
  Btn,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  GroupHeading,
  IconButton,
  PopupRoot,
  Segmented,
  SettingRow,
  SettingsSection,
  Swap,
  Switch,
  TabBar,
  TabItem,
  ThemeRoot,
} from "#kit";

/**
 * The containers and navigation of the kit in every case of their edge-case matrix at once, states set by props (no
 * presses): the tab strip (the real `DockArea` with `TabChip`s on synthetic data), chips in every state, collapsibles and
 * accordions, group headings, settings rows, the kit's tab bar. The page is the launch parameter `fixture`:
 * `tabs`, `chips`, `disclosure`, `settings`, `nav`. Not part of the app; `.shots/scenarios.ts` `kit-containers-*`.
 */
const page = typeof host.params.fixture === "string" ? host.params.fixture : "tabs";

interface Fake {
  title: string;
  project?: string;
  kind?: TabKind;
  badge?: TabBadge;
  away?: boolean;
}

const PROJECTS = ["payments-api", "herdr-desktop", "web", "infra", "ledger"];
const ALIKE = ["Fix login redirect", "Fix login redirect again", "Fix login redirect (third try)", "Fix login"];
const BADGES: TabBadge[] = ["", "signal", "unseen", "working", "", ""];

function many(count: number, start = 0): Fake[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `${ALIKE[(i + start) % ALIKE.length]} ${i + 1}`,
    project: PROJECTS[(i + start) % PROJECTS.length],
    badge: BADGES[i % BADGES.length],
  }));
}

const SCRIPTS: Fake[] = [
  { title: "修复登录重定向问题并添加回归测试", project: "支付服务", badge: "working" },
  { title: "🚀 ship the release 🎉 and tag it", project: "web", badge: "signal" },
  { title: "إصلاح إعادة التوجيه بعد تسجيل الدخول", project: "بوابة", badge: "" },
  { title: "Sửa lỗi đăng nhập ở trang thanh toán", project: "thanh-toán", badge: "unseen" },
  { title: "Review", project: "web" },
  { title: "Review", project: "web" },
  { title: "Review", project: "web" },
];

const KINDS: Fake[] = [
  { title: "Board", kind: "board" },
  { title: "Waiting on you", project: "payments-api", badge: "signal" },
  { title: "Finished, not reviewed", project: "ledger", badge: "unseen" },
  { title: "Working", project: "infra", badge: "working" },
  { title: "On an offline machine", project: "herdr-desktop", away: true },
  { title: "Offline and waiting", project: "web", away: true, badge: "signal" },
  { title: "Changes · herdr-desktop", kind: "changes" },
  { title: "Files · src", kind: "files" },
];

const Caption = (props: { text: string }) => <Text class="px-1 text-xs text-muted-foreground">{props.text}</Text>;

/** The main region's width beside the sidebar (full at 1280, the rail at 760), as the strip sees it. */
const mainWidth = () => windowSize().width - (windowSize().width < 900 ? 64 : 264);

/** One strip: the real `DockArea` holding `tabs`, front `front`, at the main region's width. */
function Strip(props: { name: string; tabs: Fake[]; front?: number; forceTiles?: boolean }) {
  const ids = props.tabs.map((_, i) => `${props.name}-${i}`);
  const of = (id: string) => props.tabs[ids.indexOf(id)];
  const tiled = () => props.forceTiles === true || tabsCompactFor(props.tabs.length, mainWidth());
  const rows = () =>
    Math.max(
      1,
      Math.ceil((tiled() ? (props.tabs.length - 1) * 32 + 196 : props.tabs.length * 124) / (mainWidth() - 8)),
    );
  return (
    <View class="gap-1" style={{ width: mainWidth() }}>
      <Caption
        text={`${props.name}: ${props.tabs.length} tab${props.tabs.length === 1 ? "" : "s"}${tiled() ? ", tiles" : ""}`}
      />
      <DockArea
        class="min-w-0"
        style={{ height: rows() * 32 + 16 }}
        locked
        compact={false}
        defaultLayout={{ center: { type: "tabs", panels: ids, activeIndex: props.front ?? 0 } }}
        renderPanel={() => <View class="flex-1 bg-background" />}
        renderTab={(tab) => (
          <TabChip
            title={of(tab.panel)?.title ?? ""}
            project={of(tab.panel)?.project}
            kind={of(tab.panel)?.kind ?? "agent"}
            badge={of(tab.panel)?.badge ?? ""}
            away={of(tab.panel)?.away}
            active={tab.active}
            closable={tab.closable}
            tiled={tiled() && !tab.active}
          />
        )}
        groupClass="bg-background"
        tabBarClass={props.tabs.length > 1 ? "flex-row flex-wrap gap-1 bg-background p-1" : "hidden"}
        tabClass={tabFrameClass(tiled())}
        contentClass="min-h-0 flex-1"
      />
    </View>
  );
}

function TabsPage() {
  return (
    <View class="gap-3 p-3">
      <Strip name="one" tabs={many(1)} />
      <Strip name="three" tabs={[KINDS[0], KINDS[1], KINDS[6]]} front={1} />
      <Strip name="twelve alike" tabs={many(12)} front={4} />
      <Strip name="thirty" tabs={many(30, 1)} front={7} />
      <Strip name="scripts" tabs={SCRIPTS} front={1} />
      <Strip name="kinds" tabs={KINDS} front={3} />
    </View>
  );
}

/** One chip outside a strip, in the frame `DockArea` gives it. */
function Chip(props: { fake: Fake; active?: boolean; hover?: boolean; tiled?: boolean }) {
  return (
    <View
      accessibilityState={{ selected: props.active === true }}
      class={`${tabFrameClass(props.tiled === true)} ${props.hover ? "bg-sidebar-accent/70" : ""}`}
      style={props.tiled && !props.active ? undefined : { width: props.tiled ? 192 : 150, flexGrow: 0 }}
    >
      <TabChip
        title={props.fake.title}
        project={props.fake.project}
        kind={props.fake.kind ?? "agent"}
        badge={props.fake.badge ?? ""}
        away={props.fake.away}
        active={props.active === true}
        closable={props.fake.kind !== "board"}
        tiled={props.tiled === true && props.active !== true}
        hover={props.hover}
      />
    </View>
  );
}

function ChipsPage() {
  const rows: { name: string; active?: boolean; hover?: boolean; tiled?: boolean }[] = [
    { name: "rest" },
    { name: "hover", hover: true },
    { name: "front", active: true },
    { name: "tile", tiled: true },
    { name: "tile hover", tiled: true, hover: true },
    { name: "tile front", tiled: true, active: true },
  ];
  return (
    <Scroll class="flex-1" contentClass="gap-3 p-3">
      <Each of={rows} key="index">
        {(row) => (
          <View class="gap-1">
            <Caption text={row().name} />
            <View class="flex-row flex-wrap gap-1 bg-background p-1">
              <Each of={KINDS} key="index">
                {(fake) => <Chip fake={fake()} active={row().active} hover={row().hover} tiled={row().tiled} />}
              </Each>
            </View>
          </View>
        )}
      </Each>
      <Caption text="scripts, front and rest" />
      <View class="flex-row flex-wrap gap-1 p-1">
        <Each of={SCRIPTS.slice(0, 4)} key="index">
          {(fake) => <Chip fake={fake()} active />}
        </Each>
        <Each of={SCRIPTS.slice(0, 4)} key="index">
          {(fake) => <Chip fake={fake()} />}
        </Each>
      </View>
    </Scroll>
  );
}

interface Row {
  head?: string;
  count?: number;
  file?: string;
}

const LINES = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a body that is far longer than the window.`);

function DisclosurePage() {
  const headings = [
    { title: "src", count: 0 },
    { title: "native/app/src", count: 1 },
    { title: "components", count: 10000 },
    { title: "a/very/long/path/that/goes/on/and/on/past/the/width/of/the/column/components/kit/icons", count: 128 },
  ];
  const rows: Row[] = Array.from({ length: 60 }, (_, i) =>
    i % 15 === 0 ? { head: `group ${i / 15 + 1}`, count: 15 } : { file: `file-${i}.tsx` },
  );
  return (
    <View class="flex-1 flex-row gap-6 p-3">
      <View class="min-w-0 flex-1 gap-3">
        <Caption text="collapsible: closed, open and empty, open with a long header, count and action" />
        <Collapsible>
          <CollapsibleTrigger chevron label="Closed section">
            <Text class="text-sm text-foreground">Closed section</Text>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <Text class="text-sm">hidden</Text>
          </CollapsiblePanel>
        </Collapsible>
        <Collapsible defaultOpen>
          <CollapsibleTrigger chevron label="Empty section">
            <Text class="text-sm text-foreground">Empty section</Text>
          </CollapsibleTrigger>
          <CollapsiblePanel />
        </Collapsible>
        <Collapsible defaultOpen>
          <View class="flex-row items-center gap-2">
            <CollapsibleTrigger chevron label="Long header" class="min-w-0 flex-1">
              <Text style={{ numberOfLines: 1 }} class="min-w-0 shrink text-sm text-foreground">
                A section header long enough to run past the column and need cutting before its count
              </Text>
              <Swap text="1,204" class="shrink-0 text-xs text-muted-foreground" />
            </CollapsibleTrigger>
            <IconButton icon="plus" label="Add" onPress={() => {}} />
          </View>
          <CollapsiblePanel class="gap-1 pl-6">
            <Each of={LINES.slice(0, 6)} key="index">
              {(l) => <Text class="text-sm text-muted-foreground">{l()}</Text>}
            </Each>
          </CollapsiblePanel>
        </Collapsible>
        <Caption text="nested, and an accordion with a disabled item" />
        <Collapsible defaultOpen>
          <CollapsibleTrigger chevron label="Outer">
            <Text class="text-sm text-foreground">Outer</Text>
          </CollapsibleTrigger>
          <CollapsiblePanel class="pl-6">
            <Collapsible defaultOpen>
              <CollapsibleTrigger chevron label="Inner">
                <Text class="text-sm text-foreground">Inner</Text>
              </CollapsibleTrigger>
              <CollapsiblePanel class="pl-6">
                <Text class="text-sm text-muted-foreground">Inner body</Text>
              </CollapsiblePanel>
            </Collapsible>
          </CollapsiblePanel>
        </Collapsible>
        <Accordion defaultValue={["b"]}>
          <AccordionItem value="a">
            <CollapsibleTrigger chevron label="First">
              <Text class="text-sm text-foreground">First</Text>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <Text class="text-sm">a</Text>
            </CollapsiblePanel>
          </AccordionItem>
          <AccordionItem value="b">
            <CollapsibleTrigger chevron label="Second, open">
              <Text class="text-sm text-foreground">Second, open</Text>
            </CollapsibleTrigger>
            <CollapsiblePanel class="pl-6">
              <Text class="text-sm text-muted-foreground">The open item's body.</Text>
            </CollapsiblePanel>
          </AccordionItem>
          <AccordionItem value="c" disabled>
            <CollapsibleTrigger chevron label="Third, disabled">
              <Text class="text-sm text-foreground">Third, disabled</Text>
            </CollapsibleTrigger>
          </AccordionItem>
        </Accordion>
        <Caption text="huge body, open" />
        <Collapsible defaultOpen>
          <CollapsibleTrigger chevron label="Huge">
            <Text class="text-sm text-foreground">Huge</Text>
          </CollapsibleTrigger>
          <CollapsiblePanel class="pl-6">
            <Each of={LINES} key="index">
              {(l) => <Text class="text-sm text-muted-foreground">{l()}</Text>}
            </Each>
          </CollapsiblePanel>
        </Collapsible>
      </View>
      <View class="min-w-0 flex-1 gap-3">
        <Caption text="group headings: 0, 1, 10000, a long path; open and closed" />
        <Each of={headings} key="index">
          {(h) => <GroupHeading title={h().title} count={h().count} open={h().count !== 1} onToggle={() => {}} />}
        </Each>
        <GroupHeading title="Conflicts" count={3} open tone="warning" onToggle={() => {}} />
        <GroupHeading title="Not foldable" count={42} />
        <Caption text="sticky while scrolling (scrolled 200 pt)" />
        <List
          each={rows}
          keyExtractor={(_r: Row, i: number) => String(i)}
          class="h-60 border-t border-border"
          contentOffset={{ y: 200 }}
          stickyHeaderIndices={rows.flatMap((r, i) => (r.head ? [i] : []))}
          estimatedItemSize={32}
        >
          {(r: () => Row) =>
            r().head ? (
              <GroupHeading title={r().head!} count={r().count!} open onToggle={() => {}} />
            ) : (
              <Text class="min-h-8 pl-6 text-sm text-foreground">{r().file!}</Text>
            )
          }
        </List>
      </View>
    </View>
  );
}

function SettingsColumn(props: { width: number }) {
  return (
    <View class="gap-4" style={{ width: props.width }}>
      <Caption text={`column ${props.width}`} />
      <SettingsSection title="Notifications">
        <SettingRow label="Short" control={<Switch checked label="Short" onChange={() => {}} />} />
        <SettingRow
          label="Notify me when an agent that runs on another machine needs an answer, even while the window is in front"
          description="Nothing is ever approved from a notification: it opens the agent's conversation, where the question waits for you."
          control={<Switch checked={false} label="Notify for remote agents" onChange={() => {}} />}
        />
        <SettingRow
          label="Density"
          description="How many rows fit."
          control={
            <Segmented
              value="cozy"
              onChange={() => {}}
              label="Density"
              options={[
                { value: "compact", label: "Compact" },
                { value: "cozy", label: "Comfortable" },
                { value: "roomy", label: "Spacious" },
                { value: "auto", label: "Follow system" },
              ]}
            />
          }
        />
        <SettingRow
          label="Sound"
          description="Play a sound when an agent waits."
          disabled
          reason="Turn on notifications first."
          control={<Switch checked={false} disabled label="Sound" onChange={() => {}} />}
        />
        <SettingRow
          label="Supercalifragilisticexpialidociousconfigurationoption"
          control={<Btn label="Reset all" onPress={() => {}} />}
        />
        <SettingRow
          label="Stacked"
          description="A wide control under the text."
          stacked
          control={
            <View class="self-start">
              <Btn label="Choose" onPress={() => {}} />
            </View>
          }
        />
      </SettingsSection>
    </View>
  );
}

function SettingsPage() {
  return (
    <Scroll class="flex-1" contentClass="flex-row flex-wrap gap-8 p-3">
      <SettingsColumn width={560} />
      <SettingsColumn width={440} />
    </Scroll>
  );
}

function NavPage() {
  const tabs = ["Transcript", "Files", "Details", "A tab with a much longer label", "Logs", "Settings of this agent"];
  return (
    <View class="gap-4 p-3">
      <Caption text="one tab" />
      <TabBar label="One">
        <TabItem label="Transcript" selected onSelect={() => {}} />
      </TabBar>
      <Caption text="counts 0, 1, 10000, disabled" />
      <TabBar label="Counts">
        <TabItem label="None" count={0} selected onSelect={() => {}} />
        <TabItem label="One" count={1} selected={false} onSelect={() => {}} />
        <TabItem label="Many" count={10000} selected={false} onSelect={() => {}} />
        <TabItem label="Disabled" disabled selected={false} onSelect={() => {}} />
      </TabBar>
      <Caption text="six long tabs in 440 pt" />
      <View class="border border-dashed border-border" style={{ width: 440 }}>
        <TabBar label="Overflow">
          <Each of={tabs} key="index">
            {(t, i) => <TabItem label={t()} selected={i() === 1} onSelect={() => {}} />}
          </Each>
        </TabBar>
      </View>
      <Caption text="vertical" />
      <View style={{ width: 200 }}>
        <TabBar label="Vertical" vertical>
          <Each of={tabs} key="index">
            {(t, i) => <TabItem label={t()} selected={i() === 0} count={i() * 7} onSelect={() => {}} />}
          </Each>
        </TabBar>
      </View>
    </View>
  );
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        {page === "chips" ? (
          <ChipsPage />
        ) : page === "disclosure" ? (
          <DisclosurePage />
        ) : page === "settings" ? (
          <SettingsPage />
        ) : page === "nav" ? (
          <NavPage />
        ) : (
          <TabsPage />
        )}
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
