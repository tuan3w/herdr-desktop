import { expect, test } from "nsh/test";
import type { MachineStatus } from "herdr-desktop/native";
import { linkGlyph, linkText } from "./machine-state";

const status = (over: Partial<MachineStatus>): MachineStatus => ({ id: "m1", name: "Build box", state: "online", newerHerdr: false, agents: 0, needsYou: 0, ...over });

test("a link that is not up says why and when it tries again, and one that needs the person says what to do", () => {
  expect(linkText(status({ state: "offline", detail: "ssh: connection refused", retryInSecs: 4 }))).toBe("Not connected: ssh: connection refused · reconnecting in 4 s");
  expect(linkText(status({ state: "offline" }))).toBe("Not connected");
  expect(linkText(status({ state: "attention", detail: "run ssh devbox once in a terminal to trust the host" }))).toContain("run ssh devbox once");
  expect(linkText(status({ state: "online", herdrVersion: "0.9.5" }))).toBe("Connected · herdr 0.9.5");
  expect(linkText(status({ state: "off" }))).toBe("Switched off");
});

test("every link state is a different shape, so none is told apart by colour alone", () => {
  const states = ["online", "connecting", "offline", "attention", "off"] as const;
  expect(new Set(states.map(linkGlyph)).size).toBe(states.length);
});
