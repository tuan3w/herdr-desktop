import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import app from "../nsh.json";

const DESKTOP = { width: 1280, height: 1000 };
const LATEST = "GET https://api.github.com/repos/tuan3w/herdr-desktop/releases/latest";
const REPO = "https://github.com/tuan3w/herdr-desktop";

const bump = (patch: number) => {
  // `0.1.0-alpha.1` bumps from its stable core, `0.1.0`.
  const [major, minor, current] = app.version.split("-")[0].split(".").map(Number);
  return `${major}.${minor}.${current + patch}`;
};

async function inSettings(
  network: NonNullable<Parameters<typeof open>[1]>["network"],
  storage?: Record<string, string>,
): Promise<App> {
  const a = await open("./machines-lab.tsx", { ...DESKTOP, network, storage });
  await a.press("Open settings");
  // The check is made when About is shown: nothing leaves the computer unless the person looks at it.
  await a.press("label:About");
  return a;
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  [LATEST]: {
    body: { tag_name: tag, html_url: `${REPO}/releases/tag/${tag}`, draft: false, prerelease: false, ...extra },
  },
});

test("a newer release is offered in Settings with a way to open its page", async () => {
  const a = await inSettings(release(`v${bump(1)}`));
  await a.waitFor("text:Update available");
  expect(a.texts().some((t) => t.includes(`Version ${bump(1)} is out`))).toBe(true);

  await a.press("Open release page");
  expect(a.openedUrls()).toEqual([`${REPO}/releases/tag/v${bump(1)}`]);
  // the one request it made is the documented one
  expect(a.requests().map((r) => `${r.method} ${r.url}`)).toEqual([LATEST]);
});

test("the same version, an older one and a pre-release show nothing", async () => {
  for (const network of [release(`v${app.version}`), release("v0.0.1"), release(`v${bump(1)}`, { prerelease: true })]) {
    const a = await inSettings(network);
    await a.waitUntil(() => a.requests().length === 1);
    expect(a.shows("text:Update available")).toBe(false);
  }
});

test("a release page outside this repository is never offered", async () => {
  const a = await inSettings({
    [LATEST]: { body: { tag_name: `v${bump(1)}`, html_url: "https://example.com/download" } },
  });
  await a.waitUntil(() => a.requests().length === 1);
  expect(a.shows("text:Update available")).toBe(false);
});

test("offline or a server error shows nothing and the rest of Settings still works", async () => {
  for (const network of [{ [LATEST]: { error: "network unreachable" } }, { [LATEST]: { status: 500, body: "oops" } }]) {
    const a = await inSettings(network);
    await a.waitUntil(() => a.requests().length === 1);
    expect(a.shows("text:Update available")).toBe(false);
    expect(a.shows("label:Check for updates")).toBe(true);
  }
});

test("switched off, nothing is asked and nothing is offered; the choice is kept", async () => {
  const a = await inSettings(release(`v${bump(1)}`), { "herdr.settings.v1": JSON.stringify({ checkUpdates: false }) });
  await a.waitFor("label:Check for updates");
  expect(a.requests()).toEqual([]);
  expect(a.shows("text:Update available")).toBe(false);

  await a.press("label:Check for updates");
  await a.waitFor("text:Update available");
  await a.press("label:Check for updates");
  expect(a.shows("text:Update available")).toBe(false);
  await a.waitUntil(() => JSON.parse(a.storage()["herdr.settings.v1"] ?? "{}").checkUpdates === false);
});
