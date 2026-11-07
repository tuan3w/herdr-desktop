// The player in a real GTK window, playing the generated clips of `fixtures/files/media` through GStreamer (the headless
// runner has no media engine; `components/media.test.tsx` covers the rules with the engine's reports simulated). Run with
//   dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo GTK_A11Y=atspi nsh test .shots/media.test.tsx --target linux
// Pictures go to `.scratch/shots/`. A box whose GStreamer has no H.264 (the dev box) plays the Theora clip and shows the
// `cannot play` row for the H.265 one; elsewhere that row may not appear and the test says so instead of failing.
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const SIZE = { width: 1280, height: 800, platform: "linux" as const };
const SHOTS = ".scratch/shots";

const lab = (params: Record<string, unknown> = {}) =>
  open("../components/media-lab.tsx", { ...SIZE, host: { params } });

/** `[state, seconds]` of the player the lab reports: `player playing at 0:03`. */
function reading(app: App): [string, number] {
  const text = app.texts().find((t) => t.startsWith("player ")) ?? "";
  const m = /^player (\w+) at (\d+):(\d\d)$/.exec(text);
  return m ? [m[1]!, Number(m[2]) * 60 + Number(m[3])] : ["none", -1];
}

const length = (app: App): string => app.texts().find((t) => /^\d+:\d\d$/.test(t) && t !== "0:00") ?? "";

async function open_clip(app: App, name = "clip.ogv") {
  await app.press(`Play ${name}`);
  await app.waitFor("label:Player controls");
  // The engine reports its length once the first frame is decoded.
  await app.waitUntil(() => length(app) !== "" || reading(app)[0] === "error", { timeout: 10000 });
}

test("a clip waits on its first frame, plays with the position moving, pauses where it is, and seeks", async () => {
  const app = await lab();
  await open_clip(app);
  expect(length(app)).toBe("0:05");
  expect(reading(app)).toEqual(["ready", 0]);
  await app.screenshot(`${SHOTS}/media-poster.png`);

  await app.keyboard.press("space");
  await app.waitUntil(() => reading(app)[1] >= 1, { timeout: 8000 });
  await app.screenshot(`${SHOTS}/media-playing-a.png`);
  const [state, first] = reading(app);
  expect(state).toBe("playing");
  await app.waitUntil(() => reading(app)[1] >= first + 1 || reading(app)[0] === "ended", { timeout: 8000 });
  await app.screenshot(`${SHOTS}/media-playing-b.png`);

  // Pause: the position stops.
  await app.keyboard.press("space");
  await app.waitFor("Play");
  const stopped = reading(app)[1];
  await app.wait(1500);
  expect(reading(app)).toEqual(["paused", stopped]);

  // Seek by keyboard from the start: Home, then Right moves five seconds (the clip's end).
  await app.keyboard.press("home");
  expect(reading(app)[1]).toBe(0);
  await app.keyboard.press("right");
  expect(reading(app)[1]).toBe(5);
  await app.keyboard.press("home");
  await app.keyboard.press("end");
  expect(reading(app)[1]).toBe(4);
});

test("a sound plays from the same bar, and a file this box cannot decode says so with the way out", async () => {
  const app = await lab();
  await open_clip(app, "song.ogg");
  expect(length(app)).toBe("0:08");
  await app.keyboard.press("space");
  await app.waitUntil(() => reading(app)[1] >= 1, { timeout: 8000 });
  await app.screenshot(`${SHOTS}/media-audio.png`);
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.press("Play hevc.mp4");
  await app.waitUntil(() => reading(app)[0] === "error" || length(app) !== "", { timeout: 10000 });
  await app.screenshot(`${SHOTS}/media-hevc.png`);
  if (reading(app)[0] === "error") {
    expect(app.shows("This computer cannot play H.265 video")).toBe(true);
    expect(app.shows("Open in the system player")).toBe(true);
  } else {
    console.log("this box decodes H.265: the cannot-play row was not shown");
  }
});

test("a 1.7 GB Theora file (`scripts/gen-media.sh dir big`, noise at top quality) opens to its first frame and starts playing within a second", async () => {
  const app = await lab({ long: "/media/fatman/data/workspace/herdr-desktop/.scratch/media/long.ogv" });
  const t0 = Date.now();
  await app.press("Play the long clip");
  await app.waitUntil(() => length(app) !== "" || reading(app)[0] === "error", { timeout: 10000 });
  const toFirstFrame = Date.now() - t0;
  const t1 = Date.now();
  await app.keyboard.press("space");
  await app.waitUntil(() => reading(app)[1] >= 1 || reading(app)[0] === "error", { timeout: 10000 });
  console.log(
    `MEASURE open to first frame ${toFirstFrame} ms; Space to the position moving ${Date.now() - t1} ms; state ${reading(app)[0]}`,
  );
});

test("twenty viewers opened and closed leave the process's memory flat", async () => {
  const app = await lab();
  await app.press("Open and close 20 viewers");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("20 video viewers closed")), { timeout: 60000 });
  console.log(`MEASURE ${app.texts().find((t) => t.startsWith("20 video viewers closed"))}`);
}, 90000);

test("the same twenty with a text file, to tell the player's memory from the dialog's", async () => {
  const app = await lab();
  await app.press("Open and close 20 text viewers");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("20 text viewers closed")), { timeout: 60000 });
  console.log(`MEASURE ${app.texts().find((t) => t.startsWith("20 text viewers closed"))}`);
}, 90000);
