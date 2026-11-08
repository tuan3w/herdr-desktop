import { expect, open, test } from "nsh/test";

/**
 * The pictures of a person's message in a chat read from a terminal's log, through the `pictures` scene of
 * `session-lab.tsx` (its fetch is a 24 pt synthetic PNG; the lab says so). The headless runner has no renderer, so what a
 * thumbnail looks like is for `make shots-mac`.
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };
const pictures = () =>
  open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene: "pictures" } } });

test("a message with a picture shows it as a thumbnail and not the agent's [Image #n] placeholder", async () => {
  const app = await pictures();
  await app.waitFor("label:Open picture");
  expect(app.texts().some((t) => t.includes("not nice."))).toBe(true);
  expect(app.texts().some((t) => t.includes("[Image #55]"))).toBe(false);
  // The words around a placeholder stay.
  expect(app.texts().some((t) => t.includes("compare these"))).toBe(true);
});

test("several pictures are told apart by position and the words keep one space where a placeholder was", async () => {
  const app = await pictures();
  await app.waitFor("label:Open picture 1 of 2");
  expect(app.texts()).toContain("and compare these");
});

test("a picture over the cap says it is too large to show", async () => {
  const app = await pictures();
  await app.waitFor("Picture too large to show");
});

test("a picture the log no longer has offers to try again", async () => {
  const app = await pictures();
  await app.waitFor("Try again");
  expect(app.texts().some((t) => t.includes("[Image #58]"))).toBe(false);
});

test("pressing a thumbnail opens it in the lightbox and Close returns to the chat", async () => {
  const app = await pictures();
  await app.waitFor("label:Open picture");
  await app.press("label:Open picture");
  await app.waitFor("label:Close");
  await app.press("label:Close");
  await app.waitFor("label:Open picture");
});
