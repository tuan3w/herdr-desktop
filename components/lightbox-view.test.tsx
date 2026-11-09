import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

/** The lightbox through the media lab, on `fixtures/files/project/assets/shot-2.png` read by the real core. */
const lab = () => open("./media-lab.tsx", { width: 1280, height: 800, platform: "linux" });

/** The zoom readout's level, in percent. */
const level = (app: App) =>
  Number(
    app
      .texts()
      .find((t) => /^\d+%$/.test(t))
      ?.slice(0, -1),
  );

test("the wheel zooms the picture without carrying it: the picture is never in the wheel's scroll view", async () => {
  const app = await lab();
  await app.press("View shot-2.png");
  await app.waitFor("label:Picture, shot-2.png");
  await app.keyboard.press("1");
  await app.waitFor("label:Zoom 100%");
  // Up is in, down is out.
  await app.scroll("id:lightbox-wheel", -30);
  const zoomedIn = level(app);
  expect(zoomedIn).toBeGreaterThan(100);
  await app.scroll("id:lightbox-wheel", 60);
  const zoomedOut = level(app);
  expect(zoomedOut).toBeLessThan(zoomedIn);
  // The platform draws a scroll the frame it happens, before the zoom and the sensor's reset arrive: a picture inside the
  // scroll view jumped along the wheel and back on every notch (owner, 2026-11-09: "it zooms in and out"). Scrolling the
  // picture itself finds no room, so it zooms nothing.
  await expect(app.scroll("label:Picture, shot-2.png", -30)).rejects.toThrow();
  expect(level(app)).toBe(zoomedOut);
});
