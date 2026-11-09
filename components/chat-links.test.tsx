import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/**
 * Links and pictures in an agent's words, through `session-lab.tsx`'s `links` scene: a scripted chat on this computer whose
 * folder is the synthetic tree (`Files.testTree`), so a picture path is read by the real file reads. What a press opens
 * is the chat's side panel; the browser hears only `Open in browser` (`openedUrls`).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const links = () => open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene: "links" } } });

const PR = "https://github.com/acme/payments-api/pull/128";
const PANEL = "label:Opened link";
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

test("a picture path in a message is a thumbnail with its name and pixel size, and a press opens it in the side panel", async () => {
  const app = await links();
  await app.waitFor("label:/^Picture shot-1\\.png · 640 × 400$/");
  expect(said(app, "shot-1.png · 640 × 400")).toBe(true);
  expect(app.shows(PANEL)).toBe(false);

  await app.press("label:/^Picture shot-1\\.png/");
  await app.waitFor(PANEL);
  await app.waitFor("label:/^shot-1\\.png, \\/.*assets\\/shot-1\\.png$/");
  // The panel names the picture and its size, and fits it.
  await app.waitUntil(() => said(app, "640 × 400 · assets"));
  expect(app.shows("label:The account page after sign-in")).toBe(true);
});

test("a picture only named in the agent's words gets its thumbnail under the paragraph", async () => {
  const app = await links();
  await app.waitFor("label:/^Picture shot-2\\.png/");
});

test("a picture over the cap is a chip that opens in the panel, and a web picture is a chip that is never fetched", async () => {
  const app = await links();
  await app.waitFor("label:Image: huge.png · too large to show");
  expect(app.shows("label:Image: build status")).toBe(true);
  // Nothing went out for the web picture: no request, nothing handed to the browser.
  expect(app.requests()).toEqual([]);
  expect(app.openedUrls()).toEqual([]);

  await app.press("label:Image: huge.png · too large to show");
  await app.waitFor(PANEL);
  await app.waitUntil(() => said(app, "too large to show here"));
});

test("a bare address reads as its host and a muted path, and its link is named by the whole address", async () => {
  const app = await links();
  await app.waitFor(`label:${PR}`);
  expect(said(app, "github.com /acme/payments-api/pull/128")).toBe(true);
  expect(said(app, PR)).toBe(false);
  const host = app.spanStyle("text:/github\\.com \\/acme/");
  const path = app.spanStyle("/acme/payments-api/pull/128");
  expect(path.color).not.toBe(host.color);
  // A long path keeps its last two segments.
  expect(said(app, "docs.example.com /…/backoff/settings")).toBe(true);
});

test("pressing a web link opens the side panel, not the browser; Open in browser hands the address over; Close shuts it", async () => {
  const app = await links();
  await app.press(`label:${PR}`);
  await app.waitFor(PANEL);
  await app.waitUntil(() => app.value("label:Address") === PR);
  expect(app.openedUrls()).toEqual([]);
  // A fresh page has no history: Back and Forward are there, and say they cannot act.
  expect(app.enabled("label:Back")).toBe(false);
  expect(app.enabled("label:Forward")).toBe(false);

  await app.press("label:Open in browser");
  await app.waitUntil(() => app.openedUrls().length === 1);
  expect(app.openedUrls()).toEqual([PR]);

  await app.press("label:Close");
  await app.waitFor(PANEL, { state: "gone" });
});

test("an address typed without a scheme opens as https in the panel, and Open in browser then hands that page over", async () => {
  const app = await links();
  await app.press(`label:${PR}`);
  await app.waitFor(PANEL);
  await app.clear("label:Address");
  await app.type("label:Address", "docs.example.com/guides");
  await app.submit("label:Address");
  await app.waitFor("label:Page https://docs.example.com/guides");
  expect(app.value("label:Address")).toBe("https://docs.example.com/guides");

  await app.press("label:Open in browser");
  await app.waitUntil(() => app.openedUrls().length === 1);
  expect(app.openedUrls()).toEqual(["https://docs.example.com/guides"]);
});

test("a typed address the panel does not show (plain http to another computer, words) is refused and the page stays", async () => {
  const app = await links();
  await app.press(`label:${PR}`);
  await app.waitFor(PANEL);
  for (const typed of ["http://example.com/", "how to fix login"]) {
    await app.clear("label:Address");
    await app.type("label:Address", typed);
    await app.submit("label:Address");
    await app.wait(100);
    expect(app.shows(`label:Page ${PR}`)).toBe(true);
  }
  expect(app.openedUrls()).toEqual([]);
});

test("Escape over a page leaves the panel open: it gives the keyboard back to the message box", async () => {
  const app = await links();
  await app.press(`label:${PR}`);
  await app.waitFor(PANEL);
  await app.hover(PANEL);
  await app.keyboard.press("escape");
  await app.wait(100);
  expect(app.shows(PANEL)).toBe(true);
});

test("a file link shows the file's name and line, and opens the file at that line in the panel", async () => {
  const app = await links();
  await app.waitFor("label:src/main.rs:12");
  expect(said(app, "main.rs:12")).toBe(true);
  await app.press("label:src/main.rs:12");
  await app.waitFor(PANEL);
  await app.waitFor("label:main.rs, read only");
  expect(app.shows("label:/^main\\.rs:12, \\/.*src\\/main\\.rs:12$/")).toBe(true);

  // The next link replaces it: one panel per chat.
  await app.press(`label:${PR}`);
  await app.waitFor("label:main.rs, read only", { state: "gone" });
  expect(app.count(PANEL)).toBe(1);
});

test("Escape closes the panel while the pointer is over it, and not from the message box", async () => {
  const app = await links();
  await app.press("label:src/main.rs:12");
  await app.waitFor(PANEL);
  // The message box has the keyboard since the chat opened: its Escape is its own.
  await app.keyboard.press("escape");
  await app.wait(100);
  expect(app.shows(PANEL)).toBe(true);
  await app.hover(PANEL);
  await app.keyboard.press("escape");
  await app.waitFor(PANEL, { state: "gone" });
});
