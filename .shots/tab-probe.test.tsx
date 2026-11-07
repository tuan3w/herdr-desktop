import { open, test } from "nsh/test";
test("tab focus", async () => {
  const app = await open("../App.tsx", { width: 1280, height: 800, platform: "linux", host: { params: { fixture: "mixed" } } });
  await app.wait(800);
  for (let i = 0; i < 6; i++) await app.keyboard.press("tab");
  await app.wait(300);
  await app.screenshot(".scratch/shots/tab6.png");
});
