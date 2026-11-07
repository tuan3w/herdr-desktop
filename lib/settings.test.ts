import { Storage } from "nsh";
import { expect, test } from "nsh/test";

import { loadSettings, mediaVolume } from "#lib/settings";

const KEY = "herdr.settings.v1";

test("the player's volume comes back as it was left, and a value out of range is ignored", async () => {
  await Storage.setItem(KEY, JSON.stringify({ mediaVolume: 0.4 }));
  await loadSettings();
  expect(mediaVolume()).toBe(0.4);
  await Storage.setItem(KEY, JSON.stringify({ mediaVolume: 7 }));
  await loadSettings();
  expect(mediaVolume()).toBe(0.4);
});
