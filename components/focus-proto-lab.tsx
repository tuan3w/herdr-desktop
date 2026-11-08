import { mount, Text, View } from "nsh";

import { Icon, PopupRoot, ThemeRoot } from "#kit";

/**
 * THROWAWAY prototype lab (not the app): the focus ring, three candidates side by side, every control kind drawn as if
 * focused. The kit's ring classes are `focus:` variants, so the lab applies the same classes WITHOUT the variant and builds
 * look-alike controls from plain Views (kit class strings copied; sizes as the kit's). Nothing here is the kit.
 *
 *   cur  today: 2 pt `ring` outline floating 2 pt off the edge (inset: -2 offset)
 *   b    the owner's input style: the control's own 1 pt border turns `ring`, a snug 3 pt halo `ring`/30 at offset 0.
 *        Borderless controls carry a 1 pt TRANSPARENT border all the time that turns `ring` on focus (nsh draws one
 *        outline per view, so the line is the border and the halo is the outline). Inset: halo drawn inside the border.
 *   c    the same with a 4 pt halo at 20%
 */
interface Cand {
  /** Classes always on a borderless control (so the geometry does not change on focus). */
  rest: string;
  bordered: string;
  borderless: string;
  inset: string;
  /** An error field: the border stays `destructive`; the halo colour is the question. */
  error: string;
}
const CANDS: Record<string, Cand> = {
  cur: {
    rest: "",
    bordered: "outline-2 outline-offset-2 outline-ring",
    borderless: "outline-2 outline-offset-2 outline-ring",
    inset: "outline-2 -outline-offset-2 outline-ring",
    error: "outline-2 outline-offset-2 outline-ring",
  },
  // B1: one 1 pt edge. A bordered control's own border turns `ring`; a borderless one carries a transparent border.
  b1: {
    rest: "border border-transparent",
    bordered: "border-ring",
    borderless: "border-ring",
    inset: "border-ring",
    error: "border-destructive",
  },
  // B15: 1.5 pt. Bordered: the 1 pt border plus a 0.5 pt outline at offset 0; borderless: a 1.5 pt outline at offset 0.
  b15: {
    rest: "",
    bordered: "border-ring outline-[0.5px] outline-offset-0 outline-ring",
    borderless: "outline-[1.5px] outline-offset-0 outline-ring",
    inset: "outline-[1.5px] -outline-offset-[1.5px] outline-ring",
    error: "border-destructive outline-[0.5px] outline-offset-0 outline-destructive",
  },
  // C: the 1 pt edge plus a very faint 2 pt halo (ring at 12%).
  c: {
    rest: "border border-transparent",
    bordered: "border-ring outline-2 outline-offset-0 outline-ring/12",
    borderless: "border-ring outline-2 outline-offset-0 outline-ring/12",
    inset: "border-ring outline-2 -outline-offset-3 outline-ring/12",
    error: "border-destructive outline-2 outline-offset-0 outline-destructive/12",
  },
};

function Row(props: { name: string; children: unknown }) {
  return (
    <View class="h-10 flex-row items-center gap-3">
      <Text class="w-20 text-xs text-muted-foreground">{props.name}</Text>
      {props.children as never}
    </View>
  );
}

function Column(props: { id: string; title: string }) {
  const c = CANDS[props.id]!;
  const input = "h-8 w-40 flex-row items-center rounded-md border border-input bg-card px-3";
  const withBorderless = (extra: string) => `${c.rest} ${c.borderless} ${extra}`;
  return (
    <View class="flex-1 gap-0 px-4">
      <Text class="pb-2 text-sm font-semibold text-foreground">{props.title}</Text>
      <Row name="text field">
        <View class={`${input} ${c.bordered}`}>
          <Text class="text-sm text-foreground">payments-api</Text>
        </View>
      </Row>
      <Row name="select">
        <View class={`${input} justify-between ${c.bordered}`}>
          <Text class="text-sm text-foreground">main</Text>
          <Icon name="chevron-down" size={14} tone="foreground" />
        </View>
      </Row>
      <Row name="combobox">
        <View class={`${input} gap-1 ${c.bordered}`}>
          <View class="rounded-sm bg-muted px-1">
            <Text class="text-xs text-foreground">api</Text>
          </View>
          <Text class="text-sm text-muted-foreground">add</Text>
        </View>
      </Row>
      <Row name="outline Btn">
        <View class={`h-8 items-center justify-center rounded-md border border-input bg-card px-3 ${c.bordered}`}>
          <Text class="text-sm text-foreground">Browse folders</Text>
        </View>
      </Row>
      <Row name="primary Btn">
        <View class={`h-8 items-center justify-center rounded-md bg-primary px-3 ${withBorderless("")}`}>
          <Text class="text-sm text-primary-foreground">Start</Text>
        </View>
      </Row>
      <Row name="ghost Btn">
        <View class={`h-8 items-center justify-center rounded-md px-3 ${withBorderless("")}`}>
          <Text class="text-sm text-foreground">Cancel</Text>
        </View>
      </Row>
      <Row name="IconButton">
        <View class={`size-8 items-center justify-center rounded-md ${withBorderless("")}`}>
          <Icon name="plus" size={16} tone="foreground" />
        </View>
      </Row>
      <Row name="check / radio">
        <View class="flex-row items-center gap-5">
          <View
            class={`size-4 rounded-sm bg-card ${c.rest ? "border border-input" : "border border-input"} ${c.bordered}`}
          />
          <View class={`size-4 rounded-full bg-card border border-input ${c.bordered}`} />
        </View>
      </Row>
      <Row name="switch">
        <View class={`h-[18px] w-[30px] rounded-full border border-input bg-muted ${c.bordered}`} />
      </Row>
      <Row name="segmented">
        <View class="h-7 flex-row items-center gap-0.5 rounded-md bg-muted p-0.5">
          <View class={`h-6 items-center justify-center rounded-sm bg-card px-3 ${c.rest} ${c.bordered}`}>
            <Text class="text-sm text-foreground">Chat</Text>
          </View>
          <View class="h-6 items-center justify-center px-3">
            <Text class="text-sm text-muted-foreground">Terminal</Text>
          </View>
        </View>
      </Row>
      <Row name="tab chip">
        <View class="h-8 flex-row overflow-hidden rounded-md bg-muted">
          <View class={`h-8 items-center justify-center bg-card px-3 ${c.rest} ${c.inset}`}>
            <Text class="text-sm text-foreground">payments</Text>
          </View>
          <View class="h-8 items-center justify-center px-3">
            <Text class="text-sm text-muted-foreground">review</Text>
          </View>
        </View>
      </Row>
      <Row name="list row">
        <View class="w-40 overflow-hidden rounded-md bg-sidebar">
          <View class={`h-8 flex-row items-center bg-accent px-3 ${c.rest} ${c.inset}`}>
            <Text class="text-sm text-foreground">payments review</Text>
          </View>
          <View class="h-8 flex-row items-center px-3">
            <Text class="text-sm text-muted-foreground">docs sweep</Text>
          </View>
        </View>
      </Row>
      <Row name="composer box">
        <View class={`h-14 w-40 rounded-xl border border-input bg-card p-3 ${c.bordered}`}>
          <Text class="text-sm text-muted-foreground">Message the agent</Text>
        </View>
      </Row>
      <Row name="error field">
        <View class={`${input} border-destructive ${c.error}`}>
          <Text class="text-sm text-foreground">not a folder</Text>
        </View>
      </Row>
    </View>
  );
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 flex-row p-4">
          <Column id="cur" title="current: 2 pt, 2 pt off" />
          <Column id="b1" title="B1: 1 pt edge" />
          <Column id="b15" title="B15: 1.5 pt edge" />
          <Column id="c" title="C: 1 pt + faint halo" />
        </View>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
