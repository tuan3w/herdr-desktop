// Scenarios for `scripts/perf.mjs` and `scripts/cpu.mjs`. Each logs `PERF-SCENARIO <name>` where it starts and runs until
// the next marker; the last marker of a window, `end`, closes its final row. Before each marker the app logs the previous
// scenario's `Herdr.metrics()` (`PERF-METRICS <json>`, on `ctrl+alt+m`), so a row also carries what only the Rust side
// can see. Hidden directory: `nsh test` skips it (it needs a window and a display). Add a scenario by adding a step
// between two markers, and a line to the table in `docs/PERFORMANCE.md` saying what it measures.
//
// Under `--target linux` this file runs apart from the app and cannot reach the native module, so what changes the
// scripted herdr lives in the entries (`perf-app.tsx`, `perf-chat.tsx` in the repository root: an app finds its fonts and icons only under its entry directory) and is started by a key press.
//
// Window 1 is the whole app on the scripted herdr of `fixtures/herdr/mixed.json`; the crowd scenarios swap its snapshot
// for `storm.json` and `big.json` (what the person sees when herdr's state changes). Window 2 is the chat tab on a real
// keeper and herdr-mobile's scripted ACP agent (`components/session-lab.tsx`), because a 5,000-item conversation needs
// the real reducer, not a script.
import { open, test } from "nsh/test";

import type { App } from "nsh/test";

/** A test is cut after 30 s by default; a scenario file is minutes long. */
const TEST_TIMEOUT = 600_000;
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const sidebarRow = (name: string) => `label:/^${name}, / >> nth=0`;

let running = false;
/** Ends the scenario that ran (the app logs its metrics) and starts `name`. */
async function mark(app: App, name: string) {
  if (running) await app.keyboard.press("ctrl+alt+m");
  console.log(`PERF-SCENARIO ${name}`);
  running = name !== "end";
}

/** Opens an agent's terminal tab from the sidebar (the sidebar opens the chat of an agent that has one, so `Show terminal` swaps it). */
async function openTerminal(app: App, name: string) {
  await app.press(sidebarRow(name));
  await app.wait(400);
  if (app.shows("Show terminal")) await app.press("Show terminal");
  await app.waitFor(`label:/^Terminal, ${name} on/`);
  await app.wait(300);
}

test(
  "scenarios",
  async () => {
    const app = await open("../perf-app.tsx", { ...DESKTOP, host: { params: { fixture: "mixed" } } });
    await app.waitFor("label:Board, 2 need you");
    await app.wait(1500);

    // Every pane that streams has 50 rows, more than its view holds.
    await app.keyboard.press("ctrl+alt+0");
    await mark(app, "idle board");
    await app.wait(5000);

    await mark(app, "palette open");
    await app.keyboard.press("ctrl+k");
    await app.wait(5000);

    await mark(app, "palette typing");
    for (const ch of "settings") {
      await app.type("label:Search agents, projects and commands", ch);
      await app.wait(150);
    }
    await app.wait(1500);
    // The first Escape clears the query, the second closes the palette.
    await app.keyboard.press("escape");
    await app.keyboard.press("escape");
    await app.wait(500);

    await mark(app, "open a pane");
    await openTerminal(app, "Refactor ledger");

    await mark(app, "idle pane");
    await app.wait(5000);

    await mark(app, "stream 8 panes, 1 open");
    await app.keyboard.press("ctrl+alt+1");
    await app.wait(1000);
    // A pane taller than its view opens at its end (its prompt), not at its top: the spinner row is the screen's last.
    if (!app.texts().some((t) => t.includes("Working (")))
      throw new Error(`the pane did not open at its end; on screen: ${JSON.stringify(app.texts().slice(0, 40))}`);
    await app.wait(7000);
    await app.keyboard.press("ctrl+alt+l");
    await app.wait(2000);

    await mark(app, "idle pane after streaming");
    await app.wait(3000);

    await mark(app, "scrollback 1000 rows, scrolled");
    // The scripted herdr gives what it holds for any source: 1000 rows, shown wrapped (the scrollback view).
    await app.keyboard.press("ctrl+alt+2");
    await app.press("label:Pane options");
    await app.press("label:Wrap lines");
    await app.wait(1500);
    const window = () => {
      const rows = app
        .texts()
        .flatMap((t) => (/scrollback row (\d+)/.exec(t) ? [Number(/scrollback row (\d+)/.exec(t)![1])] : []));
      return rows.length ? `${Math.min(...rows)}-${Math.max(...rows)}` : "none";
    };
    const seen = [window()];
    for (let i = 0; i < 12; i++) {
      await app.scroll("label:/^Terminal, Refactor ledger/", i % 4 === 3 ? 900 : -700);
      await app.wait(150);
      seen.push(window());
    }
    console.log(`PERF-NOTE scrollback: rows near the window after each scroll: ${seen.join(", ")}`);
    if (new Set(seen).size < 3) throw new Error(`the scrollback did not scroll: ${seen.join(", ")}`);
    await app.wait(1000);
    await app.press("label:Pane options");
    await app.press("label:Fit width");
    await app.wait(500);

    await mark(app, "open 2 more panes in splits");
    await app.keyboard.press("ctrl+\\");
    await app.wait(400);
    await openTerminal(app, "upgrade deps");
    await app.keyboard.press("ctrl+\\");
    await app.wait(400);
    await openTerminal(app, "Styling pass");
    await app.wait(1000);

    await mark(app, "stream 8 panes, 3 open in splits");
    await app.keyboard.press("ctrl+alt+1");
    await app.wait(8000);
    await app.keyboard.press("ctrl+alt+l");
    await app.wait(2500);
    await app.keyboard.press("ctrl+alt+r");

    await mark(app, "close panes");
    for (let i = 0; i < 3; i++) {
      await app.keyboard.press("ctrl+w");
      await app.wait(300);
    }
    await app.keyboard.press("ctrl+1");
    await app.wait(800);

    // Two projects each with an open pane, then 20 switches by key, one every 450 ms (more than the entrance's repeat
    // guard, so each one plays). The row's JS and core time per commit is the swap; its metrics say whether memory,
    // threads, descriptors and watched panes stay flat (compare with the row before).
    await openTerminal(app, "Styling pass");
    await mark(app, "switch project x20");
    for (let i = 0; i < 20; i++) {
      await app.keyboard.press(i % 2 === 0 ? "ctrl+shift+[" : "ctrl+shift+]");
      await app.wait(450);
    }
    await mark(app, "idle after 20 switches");
    await app.wait(3000);
    await app.keyboard.press("ctrl+1");
    await app.wait(800);

    await mark(app, "permission storm: 20 blocked at once");
    await app.keyboard.press("ctrl+alt+3");
    await app.wait(1500);

    await mark(app, "idle with 20 blocked");
    await app.wait(5000);

    await mark(app, "200 agents arrive");
    await app.keyboard.press("ctrl+alt+4");
    await app.wait(1500);

    await mark(app, "idle board, 200 agents");
    await app.wait(5000);

    await mark(app, "project home scroll, 200 agents");
    for (let i = 0; i < 12; i++) {
      await app.scroll("label:Projects", i % 3 === 2 ? -900 : 900);
      await app.wait(200);
    }
    await app.wait(1000);

    // The palette ranks in Rust against a copy frozen when it opens; a keystroke is that query, its marshalling and the commit
    // of the rows. Eight characters each, on about 2,000 and about 5,000 candidates (`docs/PERFORMANCE.md`).
    for (const [candidates, crowd] of [
      ["2,000", "ctrl+alt+5"],
      ["5,000", "ctrl+alt+6"],
    ] as const) {
      await mark(app, `crowd of ${candidates} candidates arrives`);
      await app.keyboard.press(crowd);
      await app.wait(3000);

      // The board of a crowd keeps pulling its rows' previews for a while; the palette is measured after that, at rest.
      await mark(app, `idle board, ${candidates} candidates`);
      await app.wait(15_000);

      await mark(app, `palette open, ${candidates} candidates`);
      await app.keyboard.press("ctrl+k");
      // Opening freezes a catalog of the whole crowd: the field is there when that is done.
      await app.waitFor("label:Search agents, projects and commands", { timeout: 30_000 });
      await app.wait(1500);

      await mark(app, `palette typing, ${candidates} candidates`);
      for (const ch of "settings") {
        await app.type("label:Search agents, projects and commands", ch);
        await app.wait(150);
      }
      await app.wait(1000);
      // The first Escape clears the query, the second closes the palette.
      await app.keyboard.press("escape");
      await app.keyboard.press("escape");
      await app.wait(500);
    }

    await mark(app, "end");
  },
  TEST_TIMEOUT,
);

test(
  "chat of 5,000 items",
  async () => {
    const app = await open("../perf-chat.tsx", { ...DESKTOP, host: { params: { mode: "keeper" } } });
    await app.waitFor("Ready", { timeout: 30_000 });
    const box = "label:Message";

    await mark(app, "chat idle, empty");
    await app.wait(3000);

    await mark(app, "chat 5,000 items arrive");
    await app.type(box, "long:5000");
    // `app.submit` types a line break on this target (it presses Return in a box that sends on Return and newline otherwise): the button sends.
    await app.press("label:Send message");
    await app.waitFor("label:/^Agent: .*line 4999/", { timeout: 300_000 });
    // The last commit of the arrival (the rows near the end) belongs to it, not to the rest that follows.
    await app.wait(1500);

    await mark(app, "chat 5,000 items, idle at the end");
    await app.wait(5000);

    await mark(app, "chat 5,000 items, scrolled");
    for (let i = 0; i < 12; i++) {
      await app.scroll("label:Conversation", i % 3 === 2 ? 1500 : -1500);
      await app.wait(200);
    }
    await app.wait(1000);

    await mark(app, "end");
  },
  TEST_TIMEOUT,
);

// A conversation in which every fourth answer carries a code block (one in five of those 60 lines): what the chat does with
// native code views in recycled list cells. The scripted port (`scene: long`, `fences`), because the keeper's agent writes no code.
test(
  "chat of 5,000 items with code",
  async () => {
    const app = await open("../perf-chat.tsx", {
      ...DESKTOP,
      host: { params: { mode: "scripted", scene: "long", rows: 5000, fences: true, quiet: true } },
    });
    await app.waitFor("label:Conversation", { timeout: 60_000 });

    await mark(app, "chat with code, 5,000 items, idle at the end");
    await app.wait(4000);

    await mark(app, "chat with code, 5,000 items, scrolled");
    for (let i = 0; i < 16; i++) {
      await app.scroll("label:Conversation", i % 4 === 3 ? 2500 : -2500);
      await app.wait(200);
    }
    await app.wait(1000);

    await mark(app, "end");
  },
  TEST_TIMEOUT,
);

// A reply that writes a 600-line fence in pieces of 20 lines, 25 times a second, in a chat that follows its end.
test(
  "chat streaming a 600-line fence",
  async () => {
    const app = await open("../perf-chat.tsx", {
      ...DESKTOP,
      host: { params: { mode: "scripted", scene: "code-stream", lines: 600, autostream: 40, quiet: true } },
    });
    await app.waitFor("label:Conversation", { timeout: 60_000 });

    await mark(app, "chat streaming a 600-line fence");
    await app.wait(2500);

    await mark(app, "chat, the fence written, idle");
    await app.wait(3000);

    await mark(app, "end");
  },
  TEST_TIMEOUT,
);
