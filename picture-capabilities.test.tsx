import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/**
 * The viewer under the capabilities the packaged app runs with: `viewer-caps-lab.tsx` sits in the root, so nsh reads the
 * real `nsh.json`. Under it an image address is allowed only as an asset, `data:`, `blob:` or an http(s) host that is
 * granted; a `file://` address can never be granted. The other viewer tests run without capabilities and cannot see this.
 */
const lab = () => open("./viewer-caps-lab.tsx", DESKTOP);

test("a picture reaches the viewer as a data address and draws under the packaged app's capabilities", async () => {
  const app = await lab();
  await app.press("Probe shot-2.png");
  await app.waitFor("text:/^probe: data:image\\/png;base64,/");
  await app.press("View shot-2.png");
  await app.waitFor("label:Picture, shot-2.png");
  expect(app.shows("This picture cannot be shown")).toBe(false);
  expect(app.texts().some((t) => t.includes("is not granted"))).toBe(false);
});

test("an SVG draws under the packaged app's capabilities", async () => {
  const app = await lab();
  await app.press("View logo.svg");
  await app.waitFor("label:Picture, logo.svg");
  expect(app.shows("This picture cannot be shown")).toBe(false);
});

test("a picture over the window's cap says it is too large and still offers Open and Reveal in its menu", async () => {
  const app = await lab();
  await app.press("View huge.png");
  await app.waitFor("This picture is not shown");
  expect(app.texts().some((t) => t.includes("too large to show here") && t.includes("Open or Reveal it"))).toBe(true);
  await app.press("More");
  await app.waitFor("Reveal");
  expect(app.shows("Open")).toBe(true);
});
