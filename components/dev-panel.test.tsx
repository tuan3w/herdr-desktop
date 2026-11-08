import { expect, test } from "nsh/test";

import { ENTRY, ready } from "../app-seam";

ENTRY.path = "../App.tsx";

// No screen of the app reads a pane through `PaneScreen` any more (the terminal tab runs the herdr client itself), so the
// pane path's lines (`Read to paint`, `Parse`) stay at "-": what the panel must still show is the app's own use.
test("the developer panel shows what the app itself uses: memory, threads and open files", async () => {
  const app = await ready();
  await app.keyboard.press("mod+shift+d");
  // The panel refreshes twice a second: wait for the line that needs a real read of the process.
  await app.waitUntil(() => app.texts().some((t) => /^\d+ · \d+$/.test(t)));

  const texts = app.texts();
  for (const label of ["Read to paint", "Pane reads", "Parse", "Rows rebound", "Memory", "Threads · fds"])
    expect(texts).toContain(label);
  const memory = texts.find((t) => /^\d+ MB$/.test(t));
  expect(Number.parseInt(memory ?? "0", 10)).toBeGreaterThan(0);
  const [threads, fds] = (texts.find((t) => /^\d+ · \d+$/.test(t)) ?? "0 · 0").split(" · ").map(Number);
  expect(threads).toBeGreaterThan(1);
  expect(fds).toBeGreaterThan(3);
});
