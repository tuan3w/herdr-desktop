import { expect, test } from "nsh/test";
import { ENTRY, FIRST, openAgents, ready } from "../app-seam";

ENTRY.path = "../App.tsx";

test("the developer panel shows what the app itself uses and how fast a watched pane is read and parsed", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  await app.keyboard.press("mod+shift+d");
  // the panel refreshes twice a second: wait for the line that needs a real read to have happened
  await app.waitUntil(() => app.texts().some((t) => /µs\/row/.test(t)));

  const texts = app.texts();
  for (const label of ["Read to paint", "Pane reads", "Parse", "Rows rebound", "Memory", "Threads · fds"]) expect(texts).toContain(label);
  const memory = texts.find((t) => /^\d+ MB$/.test(t));
  expect(Number.parseInt(memory ?? "0", 10)).toBeGreaterThan(0);
  const [threads, fds] = (texts.find((t) => /^\d+ · \d+$/.test(t)) ?? "0 · 0").split(" · ").map(Number);
  expect(threads).toBeGreaterThan(1);
  expect(fds).toBeGreaterThan(3);
});
