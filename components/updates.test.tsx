import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { UPDATE_COMMAND } from "#lib/updates";

import app from "../nsh.json";

const DESKTOP = { width: 1280, height: 1000 };
const RELEASES = "GET https://api.github.com/repos/tuan3w/herdr-desktop/releases";
const REPO = "https://github.com/tuan3w/herdr-desktop";

/** `0.1.0-alpha.7` + 1 is `0.1.0-alpha.8`; a stable `0.1.3` + 1 is `0.1.4`. */
const bump = (step: number) => {
  const m = /^(.*\.)(\d+)$/.exec(app.version);
  return m ? `${m[1]}${Number(m[2]) + step}` : app.version;
};

async function inSettings(
  network: NonNullable<Parameters<typeof open>[1]>["network"],
  storage?: Record<string, string>,
): Promise<App> {
  const a = await open("./machines-lab.tsx", { ...DESKTOP, network, storage });
  // A press that lands while the lab is still drawing is lost; opening Settings twice is the same as once.
  for (let attempt = 0; attempt < 5 && !a.shows("label:About"); attempt++) {
    await a.press("Open settings");
    await a.waitUntil(() => a.shows("label:About"), { timeout: 2000 }).catch(() => undefined);
  }
  // The check is made when About is shown: nothing leaves the computer unless the person looks at it.
  await a.press("label:About");
  return a;
}

const entry = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `${REPO}/releases/tag/${tag}`,
  draft: false,
  prerelease: true,
  ...extra,
});
const releases = (...list: Record<string, unknown>[]) => ({ [RELEASES]: { body: list } });

test("the newest release of the line is offered, pre-releases and the edge build aside, with how to install it", async () => {
  const a = await inSettings(
    releases(entry("edge"), entry(`v${bump(1)}`), entry(`v${bump(2)}`), entry(`v${bump(3)}`, { draft: true })),
  );
  await a.waitFor("text:Update available");
  expect(a.texts().some((t) => t.includes(`Version ${bump(2)} is out`))).toBe(true);

  await a.press("Copy install command");
  await a.waitUntil(() => a.clipboard() === UPDATE_COMMAND);
  await a.press("Open release page");
  expect(a.openedUrls()).toEqual([`${REPO}/releases/tag/v${bump(2)}`]);
  // the one request it made is the documented one
  expect(a.requests().map((r) => `${r.method} ${r.url}`)).toEqual([RELEASES]);
});

test("the same version or older ones say up to date, never nothing", async () => {
  const a = await inSettings(releases(entry(`v${app.version}`), entry(`v${bump(-1)}`), entry("v0.0.1")));
  await a.waitFor("text:Up to date");
  expect(a.shows("text:Update available")).toBe(false);
});

test("a release page outside this repository is never offered", async () => {
  const a = await inSettings(releases(entry(`v${bump(1)}`, { html_url: "https://example.com/download" })));
  await a.waitFor("text:Up to date");
  expect(a.shows("text:Update available")).toBe(false);
});

test("offline or a server error says it could not check, offers a retry, and the rest of Settings still works", async () => {
  for (const network of [
    { [RELEASES]: { error: "network unreachable" } },
    { [RELEASES]: { status: 500, body: "oops" } },
  ]) {
    const a = await inSettings(network);
    await a.waitFor("text:Could not check for updates");
    expect(a.shows("label:Check for updates")).toBe(true);
    await a.press("Try again");
    await a.waitUntil(() => a.requests().length === 2);
  }
});

test("switched off, nothing is asked and nothing is offered; the choice is kept", async () => {
  const a = await inSettings(releases(entry(`v${bump(1)}`)), {
    "herdr.settings.v1": JSON.stringify({ checkUpdates: false }),
  });
  await a.waitFor("label:Check for updates");
  expect(a.requests()).toEqual([]);
  expect(a.shows("text:Update available")).toBe(false);

  await a.press("label:Check for updates");
  await a.waitFor("text:Update available");
  await a.press("label:Check for updates");
  expect(a.shows("text:Update available")).toBe(false);
  await a.waitUntil(() => JSON.parse(a.storage()["herdr.settings.v1"] ?? "{}").checkUpdates === false);
});
