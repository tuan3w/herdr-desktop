import { Storage } from "nsh";
import { expect, test } from "nsh/test";

import { loadSettings, mediaVolume, terminalFontSize } from "#lib/settings";

const KEY = "herdr.settings.v1";

test("the player's volume comes back as it was left, and a value out of range is ignored", async () => {
  await Storage.setItem(KEY, JSON.stringify({ mediaVolume: 0.4 }));
  await loadSettings();
  expect(mediaVolume()).toBe(0.4);
  await Storage.setItem(KEY, JSON.stringify({ mediaVolume: 7 }));
  await loadSettings();
  expect(mediaVolume()).toBe(0.4);
});

test("the terminal's font size is a whole number of points from 10 to 16, else the saved one stays", async () => {
  await Storage.setItem(KEY, JSON.stringify({ terminalFontSize: 14 }));
  await loadSettings();
  expect(terminalFontSize()).toBe(14);
  for (const bad of [9, 17, 12.5, "13"]) {
    await Storage.setItem(KEY, JSON.stringify({ terminalFontSize: bad }));
    await loadSettings();
    expect(terminalFontSize()).toBe(14);
  }
});
