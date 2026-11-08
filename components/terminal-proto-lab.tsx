import { host, mount, Text, View } from "nsh";

import { ThemeRoot } from "#kit";

/**
 * THROWAWAY prototype lab (not the app): the geometry of the native terminal view drawn as TSX rows of monospace text, the way
 * `native/app/src/terminal/view.rs` draws them (one fixed-height row per line, a vertically centred single-line run of
 * coloured spans, a row-wide background for a diff). Direction comes from the launch parameter `fixture` (A to E, or
 * `compare` for A beside C); all content is synthetic. Cell width uses 0.6 em (IBM Plex Mono's advance; the lab's own mono
 * may differ a little), so the printed cell sizes are the design's, not a measurement.
 */
const DIRS: Record<string, [number, number]> = {
  A: [13, 1.4],
  B: [12, 1.2],
  C: [12, 1.25],
  D: [13, 1.2],
  E: [12.5, 1.2],
};
const RATIO = 0.6;
const lineHeight = (size: number, lead: number) => Math.round(size * lead);

type Seg = [string, string?, string?, boolean?];
type Line = { segs: Seg[]; bg?: string };
const G = "#2fa35f";
const R = "#e0505a";
const Y = "#d19a2a";
const B = "#4a8fe0";
const M = "#b05fd0";
const C = "#2aa3b2";
const DIM = "#808794";
const L = (...segs: Seg[]): Line => ({ segs });
const W = 100;
const bar = (n: number) => "█".repeat(Math.floor(n)) + (n % 1 >= 0.5 ? "▌" : "");
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));

const inner = W - 4;
const box = (s: string, color = B): Line => L(["│ ", color], [pad(s, inner)], [" │", color]);
const LINES: Line[] = [
  L(
    ["╭─ ", B],
    ["agent: payments-api review", undefined, undefined, true],
    [` ${"─".repeat(W - 33)}`, B],
    ["─ 12m ─╮", B],
  ),
  box("Reviewing 14 files in src/ledger; 3 need a change before the migration can land."),
  L(["│ ", B], ["✓ ", G], [pad("read_file  src/ledger/post.rs", inner - 2)], [" │", B]),
  L(["│ ", B], ["✓ ", G], [pad("grep       'balance_after' (12 matches in 5 files)", inner - 2)], [" │", B]),
  L(["│ ", B], ["● ", Y], [pad("bash       cargo test -p ledger --lib", inner - 2)], [" │", B]),
  L(["├", B], ["─".repeat(W - 2), B], ["┤", B]),
  L(
    ["│ ", B],
    ["progress  "],
    [bar(24.5), G],
    [pad("", 30 - 24.5 + 0), DIM],
    [pad(" 82%", inner - 10 - 25 - 5 + 5), DIM],
    [" │", B],
  ),
  L(["│ ", B], ["tokens    "], [bar(11), C], [pad(" 41k / 128k", inner - 10 - 11), DIM], [" │", B]),
  L(["╰", B], ["─".repeat(W - 2), B], ["╯", B]),
  L(["┃ ", M], ["Plan", undefined, undefined, true], [pad("", W - 6), undefined]),
  L(["┃ ", M], ["1. Move the rounding rule into post.rs", DIM]),
  L(["┃ ", M], ["2. Add a test for a negative remainder", DIM]),
  L(["┃ ", M], ["3. Re-run the migration dry run", DIM]),
  L([""]),
  L(
    ["┌", DIM],
    ["─".repeat(20) + "┬" + "─".repeat(12) + "┬" + "─".repeat(14) + "┬" + "─".repeat(W - 51), DIM],
    ["┐", DIM],
  ),
  L(
    ["│ ", DIM],
    [pad("file", 19)],
    ["│ ", DIM],
    [pad("changes", 11)],
    ["│ ", DIM],
    [pad("status", 13)],
    ["│ ", DIM],
    [pad("note", W - 52)],
    ["│", DIM],
  ),
  L(
    ["├", DIM],
    ["─".repeat(20) + "┼" + "─".repeat(12) + "┼" + "─".repeat(14) + "┼" + "─".repeat(W - 51), DIM],
    ["┤", DIM],
  ),
  L(
    ["│ ", DIM],
    [pad("post.rs", 19)],
    ["│ ", DIM],
    [pad("+42 -7", 11), G],
    ["│ ", DIM],
    [pad("passing", 13), G],
    ["│ ", DIM],
    [pad("rounding moved here", W - 52)],
    ["│", DIM],
  ),
  L(
    ["│ ", DIM],
    [pad("reconcile.rs", 19)],
    ["│ ", DIM],
    [pad("+9 -31", 11), R],
    ["│ ", DIM],
    [pad("failing", 13), R],
    ["│ ", DIM],
    [pad("日本語 のテスト wide cells", W - 52)],
    ["│", DIM],
  ),
  L(
    ["└", DIM],
    ["─".repeat(20) + "┴" + "─".repeat(12) + "┴" + "─".repeat(14) + "┴" + "─".repeat(W - 51), DIM],
    ["┘", DIM],
  ),
  L([""]),
  L(["diff --git a/src/ledger/post.rs b/src/ledger/post.rs", undefined, undefined, true]),
  L(["@@ -41,7 +41,9 @@ fn post(entry: &Entry) -> Result<Balance>", C]),
  L([" ", DIM], ["    let before = self.balance(entry.account)?;", DIM]),
  { segs: [["-    let after = before - entry.amount;", R]], bg: "rgba(240,80,90,0.20)" },
  { segs: [["+    let after = round_half_even(before - entry.amount);", G]], bg: "rgba(60,200,110,0.18)" },
  { segs: [['+    debug_assert!(after >= Money::ZERO, "negative balance");', G]], bg: "rgba(60,200,110,0.18)" },
  L([" ", DIM], ["    self.write(entry.account, after)", DIM]),
  L([""]),
  L(["running 38 tests ", DIM], ["test ledger::post::rounds_half_even ... ", undefined], ["ok", G]),
  L(["test ledger::reconcile::negative_remainder ... ", undefined], ["FAILED", R, undefined, true]),
  L([
    "thread 'ledger::reconcile' panicked at src/ledger/reconcile.rs:88:9: assertion `left == right` failed: remainder was -0.005, expected 0.00 after rounding the final entry of the batch (a long line that must wrap in a real pane and does here too)",
    DIM,
  ]),
  L([""]),
  L(["▏", B], [" ▎▍▌▋▊▉█ ", B], ["░▒▓ ", DIM], ["⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", Y], ["  ▀▄▀▄  ◢◣◥◤  ", DIM], ["╔═══╗ ╚═══╝ ║", DIM]),
  L(
    ["  ", undefined],
    ["truecolor: ", DIM],
    ["███", "#ff5f5f"],
    ["███", "#ffaf5f"],
    ["███", "#ffff5f"],
    ["███", "#5fff5f"],
    ["███", "#5fffff"],
    ["███", "#5f5fff"],
    ["███", "#ff5fff"],
  ),
  L([""]),
  L(["╭", DIM], ["─".repeat(W - 2), DIM], ["╮", DIM]),
  L(
    ["│ ", DIM],
    ["> ", M, undefined, true],
    [pad("fix the failing reconcile test, then run the full suite", W - 6)],
    [" │", DIM],
  ),
  L(["│ ", DIM], [pad("", W - 4)], [" │", DIM]),
  L(["╰", DIM], ["─".repeat(W - 2), DIM], ["╯", DIM]),
  L(["  ? for shortcuts", DIM], [pad("", W - 40)], ["claude-sonnet · 41k tokens", DIM]),
  L(["~/work/payments-api ", C], ["on ", DIM], ["main ", M], ["❯ ", G], [" ", "#0b0d10", "#d7dae0"]),
];

// The app's IBM Plex Mono is not found from components/ (fonts load only beside the entry); Menlo has the same 0.6 em advance.
const CELL_FONT = (size: number) => ({ fontSize: size, fontFamily: "Menlo" });

function Row({ line, size, lh }: { line: Line; size: number; lh: number }) {
  return (
    <View style={{ height: lh, justifyContent: "center", backgroundColor: line.bg }}>
      <Text class="text-neutral-800 dark:text-neutral-200" style={{ ...CELL_FONT(size), numberOfLines: 1 }}>
        {line.segs.map(([t, fg, bg, bold]) => (
          <Text
            style={{
              ...CELL_FONT(size),
              color: fg ?? undefined,
              backgroundColor: bg,
              fontWeight: bold ? "700" : undefined,
            }}
          >
            {t}
          </Text>
        ))}
      </Text>
    </View>
  );
}

function Pane({ name, width, height, scale = 1 }: { name: string; width: number; height: number; scale?: number }) {
  const [pt, lead] = DIRS[name]!;
  const size = pt * scale;
  const lh = lineHeight(size, lead);
  const rows = Math.floor(height / lh);
  const cw = size * RATIO;
  const cols = Math.floor(width / cw);
  const r640 = Math.floor(640 / lh);
  const r800 = Math.floor(800 / lh);
  return (
    <View class="gap-1" style={{ width }}>
      <Text class="text-xs text-foreground">
        {`${name}${scale === 2 ? " @ fontScale 2.0" : ""}: ${size} pt / ${lead} = row ${lh} pt, cell ${cw.toFixed(1)} x ${lh} pt | 1000x640 pane: ${Math.floor(1000 / cw)} cols x ${r640} rows | 800 px: ${r800} rows`}
      </Text>
      <View class="bg-neutral-100 dark:bg-neutral-900" style={{ width, height, overflow: "hidden", padding: 0 }}>
        {LINES.slice(0, rows).map((l) => (
          <Row line={l} size={size} lh={lh} />
        ))}
      </View>
    </View>
  );
}

/** What the pane sits next to: a chat message at 14/1.55 and a sidebar row at 13, in the app's own tokens. */
function Context() {
  return (
    <View class="flex-row gap-6 border-b border-border p-3" style={{ height: 96 }}>
      <View class="gap-1" style={{ width: 240 }}>
        <Text class="text-xs text-muted-foreground">sidebar rows, 13 pt</Text>
        <View class="flex-row items-center gap-2" style={{ height: 32 }}>
          <Text class="text-sm text-foreground">● payments-api review</Text>
        </View>
        <View class="flex-row items-center gap-2" style={{ height: 32 }}>
          <Text class="text-sm text-muted-foreground">○ Refactor ledger</Text>
        </View>
      </View>
      <View class="gap-1" style={{ width: 640 }}>
        <Text class="text-xs text-muted-foreground">chat prose, 14 pt / 1.55</Text>
        <Text class="text-base text-foreground">
          I moved the rounding rule into post.rs and added a test for the negative remainder. Two files still need a
          change before the migration can land; the reconcile test fails on the last entry of a batch.
        </Text>
      </View>
    </View>
  );
}

const mode = String((host.params as { fixture?: string }).fixture ?? "A").toUpperCase();

function Lab() {
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background">
        <Context />
        <View class="gap-2 p-3">
          {mode === "COMPARE" ? (
            <View class="flex-row gap-3">
              <Pane name="A" width={620} height={620} />
              <Pane name="C" width={620} height={620} />
            </View>
          ) : mode === "C2" ? (
            <Pane name="C" width={1000} height={560} scale={2} />
          ) : (
            <Pane name={mode} width={1000} height={560} />
          )}
        </View>
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
