import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import {
  controlsHidden,
  HIDE_AFTER_MS,
  keysSpoken,
  railValue,
  scrubbed,
  stageFit,
  unmuteLevel,
  VOLUME_STEP,
} from "#components/media-player";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/**
 * The player against the generated clips of `fixtures/files/media`. A headless run has no media engine, so the lab's `Sim`
 * buttons play the host's part (`loaded`, `progress`, `ended`, `error`); the real engine is the GTK smoke
 * (`.shots/media.test.tsx`). The manual clock makes the seek settling deterministic.
 */
const lab = () => open("./media-lab.tsx", { ...DESKTOP, clock: {}, host: { params: { sim: true } } });

const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

async function playing(name: string) {
  const app = await lab();
  await app.press(`Play ${name}`);
  await app.waitFor("label:Player controls");
  return app;
}

async function loaded(app: App) {
  await app.press("Sim loaded 125 s");
  await app.waitFor("2:05");
}

test("a clip waits paused with its length shown, and Space plays and pauses it", async () => {
  const app = await playing("clip.ogv");
  expect(said(app, "player loading at 0:00")).toBe(true);
  await loaded(app);
  expect(said(app, "player ready at 0:00")).toBe(true);
  expect(app.shows("Play")).toBe(true);
  await app.keyboard.press("space");
  await app.waitFor("Pause");
  expect(said(app, "player playing at 0:00")).toBe(true);
  await app.keyboard.press("space");
  await app.waitFor("Play");
  expect(said(app, "player paused at 0:00")).toBe(true);
});

test("the play button does what Space does, and nothing starts by itself", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  expect(app.shows("Pause")).toBe(false);
  await app.press("Play");
  await app.waitFor("Pause");
  await app.press("Pause");
  await app.waitFor("Play");
});

test("the arrow keys seek five seconds, Shift thirty, and stop at both ends", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.keyboard.press("right");
  expect(said(app, "at 0:05")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("shift+right");
  expect(said(app, "at 0:35")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("left");
  expect(said(app, "at 0:30")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("shift+left");
  await app.clock!.runFor(700);
  await app.keyboard.press("shift+left");
  expect(said(app, "at 0:00")).toBe(true);
  await app.keyboard.press("end");
  expect(said(app, "at 2:04")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("shift+right");
  expect(said(app, "at 2:05")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("home");
  expect(said(app, "at 0:00")).toBe(true);
});

test("the engine's report right after a seek does not pull the bar back, a later one moves it", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.keyboard.press("space");
  await app.press("Sim progress +5 s");
  expect(said(app, "playing at 0:05")).toBe(true);
  await app.clock!.runFor(700);
  await app.keyboard.press("shift+right");
  expect(said(app, "at 0:35")).toBe(true);
  // The engine reported 10 s from before the jump: ignored while it settles.
  await app.press("Sim progress +5 s");
  expect(said(app, "at 0:35")).toBe(true);
  await app.clock!.runFor(700);
  await app.press("Sim progress +5 s");
  expect(said(app, "at 0:15")).toBe(true);
});

test("when it ends the controls say so and Space plays it again from the start", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.keyboard.press("space");
  await app.press("Sim ended");
  expect(said(app, "player ended at 2:05")).toBe(true);
  expect(app.shows("Play")).toBe(true);
  await app.keyboard.press("space");
  await app.waitFor("Pause");
  expect(said(app, "player playing at 0:00")).toBe(true);
});

test("volume has keys and a button, mute and loop toggle, and each control has a name", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  expect(app.shows("label:Volume")).toBe(true);
  expect(app.shows("label:Position")).toBe(true);
  expect(app.shows("Mute")).toBe(true);
  await app.keyboard.press("m");
  await app.waitFor("Unmute");
  await app.keyboard.press("m");
  await app.waitFor("Mute");
  await app.press("Mute");
  await app.waitFor("Unmute");
  // Raising the volume while muted brings the sound back.
  await app.keyboard.press("up");
  await app.waitFor("Mute");
  expect(app.shows("Loop")).toBe(true);
  expect(app.shows("Full screen")).toBe(true);
});

test("a sound has no full screen and shows its name, and a video with no picture is told so", async () => {
  const app = await playing("song.ogg");
  await loaded(app);
  expect(app.shows("Full screen")).toBe(false);
  expect(app.shows("song.ogg")).toBe(true);
  await app.keyboard.press("escape");
  await app.press("Play clip.ogv");
  await app.waitFor("label:Player controls");
  await app.press("Sim loaded sound 125 s");
  await app.waitFor("This file has sound and no picture");
  expect(app.shows("Full screen")).toBe(false);
});

test("a file the system cannot play says which codec it is and offers the system's player", async () => {
  const app = await playing("hevc.mp4");
  await loaded(app);
  await app.press("Sim error");
  await app.waitFor("This computer cannot play H.265 video");
  expect(said(app, "Missing a plug-in")).toBe(true);
  expect(app.shows("Open in the system player")).toBe(true);
  expect(app.shows("Reveal in the file manager")).toBe(true);
  expect(app.shows("Copy path")).toBe(true);
  // The controls no longer pretend: a key does nothing to a player that cannot play.
  await app.keyboard.press("space");
  expect(said(app, "player error")).toBe(true);
});

test("a file whose headers name nothing still gets a sentence and the way out", async () => {
  const app = await playing("broken.mp4");
  await loaded(app);
  await app.press("Sim error");
  await app.waitFor("This computer cannot play this video");
  expect(said(app, "Missing a plug-in to decode this format")).toBe(true);
  expect(app.shows("Open in the system player")).toBe(true);
});

test("a clip that plays names its codecs when it does not: Theora here", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.press("Sim error");
  await app.waitFor("This computer cannot play Theora video and Vorbis audio");
});

test("closing the viewer takes the player away, and a keypress then does not reach it", async () => {
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.keyboard.press("escape");
  await app.waitFor("Player controls", { state: "gone" });
  expect(said(app, "player none")).toBe(true);
  await app.keyboard.press("space");
  expect(said(app, "player none")).toBe(true);
});

const remote = (params: Record<string, unknown>) =>
  open("./media-lab.tsx", { ...DESKTOP, host: { params: { sim: true, ...params } } });

test("a file of another machine is copied first, with progress, and plays once it is here", async () => {
  const app = await remote({ slowCopy: 400 });
  await app.press("Play clip.ogv");
  await app.waitFor("Copying from This computer");
  expect(app.shows("label:Copying the file")).toBe(true);
  expect(app.shows("Cancel")).toBe(true);
  expect(app.shows("label:Player controls")).toBe(false);
  await app.waitFor("label:Player controls", { timeout: 15000 });
  expect(app.shows("Copying from This computer")).toBe(false);
});

test("Cancel stops the copy and leaves a way to start it again", async () => {
  const app = await remote({ slowCopy: 700 });
  await app.press("Play clip.ogv");
  await app.waitFor("Cancel");
  await app.press("Cancel");
  await app.waitFor("The copy was stopped");
  expect(app.shows("label:Player controls")).toBe(false);
  await app.press("Copy again");
  await app.waitFor("Copying from This computer");
  await app.waitFor("label:Player controls", { timeout: 15000 });
});

test("a file bigger than the cache is refused with both sizes and the way on, and nothing is copied", async () => {
  const app = await remote({ slowCopy: 1, cap: 20000 });
  await app.press("Play clip.ogv");
  await app.waitFor("This file cannot be played");
  expect(said(app, "keeps up to 20 KB")).toBe(true);
  expect(said(app, "open it on that machine instead")).toBe(true);
  expect(app.shows("Try again")).toBe(true);
  expect(app.shows("label:Player controls")).toBe(false);
});

test("a drag shows where it is and seeks once, on release; a key step seeks at once", () => {
  expect(scrubbed("change", 65)).toEqual({ preview: 65, seek: null });
  expect(scrubbed("change", 70)).toEqual({ preview: 70, seek: null });
  expect(scrubbed("end", 70)).toEqual({ preview: null, seek: 70 });
  expect(railValue(65, 10)).toBe(65);
  expect(railValue(null, 10)).toBe(10);
});

test("the controls hide only in full screen, only while playing, and only after the quiet time", () => {
  const quiet = HIDE_AFTER_MS;
  expect(controlsHidden({ fullscreen: true, playing: true, idleMs: quiet - 1 })).toBe(false);
  expect(controlsHidden({ fullscreen: true, playing: true, idleMs: quiet })).toBe(true);
  expect(controlsHidden({ fullscreen: true, playing: false, idleMs: quiet * 4 })).toBe(false);
  expect(controlsHidden({ fullscreen: false, playing: true, idleMs: quiet * 4 })).toBe(false);
});

test("Unmute gives back the last level when the slider left the sound at 0, else it only clears the mute", () => {
  expect(unmuteLevel(0, 0.6)).toBe(0.6);
  expect(unmuteLevel(0.3, 0.6)).toBeNull();
});

test("the stage takes the picture's shape between a floor and a ceiling, and stays put until it is known", () => {
  expect(stageFit(0, { width: 1920, height: 1080 })).toBe(400);
  expect(stageFit(700, null)).toBe(400);
  expect(stageFit(560, { width: 1920, height: 1080 })).toBe(315);
  expect(stageFit(300, { width: 1920, height: 1080 })).toBe(240);
  expect(stageFit(900, { width: 1080, height: 1920 })).toBe(400);
});

test("Up and Down move the volume one slider step, and the Keys button names every key", async () => {
  expect(VOLUME_STEP).toBe(0.05);
  const app = await playing("clip.ogv");
  await loaded(app);
  await app.keyboard.press("down");
  expect(said(app, "volume 95%")).toBe(true);
  await app.keyboard.press("up");
  expect(said(app, "volume 100%")).toBe(true);
  expect(app.shows(`label:${keysSpoken()}`)).toBe(true);
});
