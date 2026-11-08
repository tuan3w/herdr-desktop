#!/usr/bin/env node
// Screenshots of the real AppKit window on macOS, one window, never the screen.
//
//   make shots-mac ARGS="settings"                       # a .shots scenario, 1280 light
//   make shots-mac ARGS="--entry components/menus.fixture.tsx --press 'text:Sort' --size 960x700 --theme dark --name menu"
//   node scripts/shots-mac.mjs <scenario|--entry file> [--size 1280x800|960x700|760x640] [--theme light|dark|both]
//                              [--press selector]... [--wait ms] [--name out] [--theme-id id]
//
// How it is safe: it writes a tiny test under .scratch/shots-mac/ and runs `nsh test --target macos` on it with
// HERDR_DESKTOP_TEST=1 (the fake-herdr fixture seam; without it the app reads the owner's real projects and machines).
// The picture is nsh's own `app.screenshot` of the window it opened (PNG bytes from the host), so no screen capture, no
// Screen Recording permission and no window id are involved. nsh starts and closes its own host; this script spawns only
// that one child and, on a timeout, kills exactly that PID.
//
// The AppKit test host takes the keyboard focus (nsh calls activateIgnoringOtherApps when it starts a window and on every
// injected press). So the host is started with scripts/no-focus (a test-only DYLD_INSERT_LIBRARIES library that turns those
// calls into no-ops and keeps the window behind): the person keeps typing in their own app while a render runs. Runs are
// serialised by a lock under .scratch/. `--polite` is the older fallback (wait until the person is idle, give the focus
// back); `--no-interpose` runs the host as nsh ships it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".scratch", "shots-mac");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const flagged = new Set([
  "entry",
  "size",
  "theme",
  "press",
  "wait",
  "name",
  "theme-id",
  "timeout",
  "idle",
  "max-wait",
  "keys",
  "settle",
  "js",
  "fixture",
  "test-timeout",
]);
const scenario = args.find(
  (a, i) => !a.startsWith("--") && !(i > 0 && flagged.has(args[i - 1].slice(2)) && args[i - 1].startsWith("--")),
);

const entry = opt("entry");
if (!entry && !scenario) {
  console.error(
    "usage: shots-mac.mjs <scenario> | --entry <components/x-lab.tsx> [--size WxH] [--theme light|dark|both] [--press sel]... [--wait ms] [--name n]",
  );
  process.exit(2);
}
if (process.platform !== "darwin") {
  console.error("shots-mac is for macOS; use `make shots` (Xvfb) on Linux");
  process.exit(2);
}
const [w, h] = opt("size", "1280x800").split("x").map(Number);
if (!(w > 0 && h > 0)) throw new Error("bad --size");
const themeArg = opt("theme", "light");
const themes = themeArg === "both" ? ["light", "dark"] : [themeArg];
if (themes.some((t) => t !== "light" && t !== "dark")) throw new Error("--theme is light, dark or both");
const name = opt("name", entry ? entry.replace(/^.*\//, "").replace(/\.tsx$/, "") : scenario).replace(/[^\w.-]/g, "_");
const presses = all("press");
const keys = all("keys"); // key chords sent first, e.g. --keys meta+, (mod is Cmd on a Mac)
const noSteps = args.includes("--no-steps"); // skip the scenario's own steps (they press Linux chords)
const js = all("js"); // free steps with `app` in scope, e.g. --js "await app.type(\"label:Machine\", \"x\")"; they may call app.screenshot(path) themselves
const wait = Number(opt("wait", "600"));
const settle = Number(opt("settle", "1200")); // ms after each key or press (dialogs and popups animate in)
const timeout = Number(opt("timeout", "180")) * 1000;
if (entry && !existsSync(join(root, entry))) throw new Error(`no such entry: ${entry}`);

mkdirSync(out, { recursive: true });
const testRel = `.scratch/shots-mac/run-${name}.test.tsx`;
const testFile = join(root, testRel);
const pngFor = (t) => `.scratch/shots-mac/${name}-${w}-${t}.png`;
// Appearance: `app.setColorScheme` makes the window follow light or dark, as the system setting would; the app's theme
// (`themeId`) has a light and a dark variant of its own and follows it (lib/settings.ts, lib/theme).
writeFileSync(
  testFile,
  `import { open, test } from "nsh/test";
${scenario ? `import { SCENARIOS } from "../../.shots/scenarios";\nconst sc = SCENARIOS[${JSON.stringify(scenario)}];\nif (!sc) throw new Error("no scenario ${scenario}");` : `const sc = { fixture: ${JSON.stringify(opt("fixture", "mixed"))}, entry: ${JSON.stringify("../../" + entry)}, params: {}, steps: async (app: any) => { for (const p of ${JSON.stringify(presses)}) { await app.press(p); await app.wait(${settle}); } } };`}
for (const scheme of ${JSON.stringify(themes)} as const) {
  test("shot " + scheme, async () => {
    const app = await open(${scenario ? `sc.entry ? sc.entry.replace("../", "../../") : "../../App.tsx"` : "sc.entry"}, {
      width: ${w},
      height: ${h},
      platform: "macos",
      host: { params: { fixture: sc.fixture, ...sc.params } },
    });
    await app.setColorScheme(scheme);
    await app.wait(${wait});
    ${noSteps ? "" : "await sc.steps(app);"}
${js.map((j) => `    ${j};\n`).join("")}${keys.map((k) => `    await app.keyboard.press(${JSON.stringify(k)}); await app.wait(${settle});\n`).join("")}${scenario && presses.length ? `    for (const p of ${JSON.stringify(presses)}) { await app.press(p); await app.wait(${settle}); }\n` : ""}    await app.screenshot(scheme === "light" ? ${JSON.stringify(pngFor("light"))} : ${JSON.stringify(pngFor("dark"))});
    await sc.cleanup?.(app);
  }, ${Number(opt("test-timeout", "30")) * 1000}); // --test-timeout s: a scenario of many steps outlives nsh's 30 s
}
`,
);

// ---- focus etiquette: wait for idle, one window at a time, give the focus back ----
const idleNeed = Number(opt("idle", "15"));
const maxWait = Number(opt("max-wait", "1800")) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idleSeconds = () => {
  try {
    const text = execFileSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" });
    const m = text.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : Infinity;
  } catch {
    return Infinity;
  }
};
const frontBundle = () => {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const info = execFileSync("lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" });
    return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
};
const lockDir = join(root, ".scratch", ".window-lock");
const takeLock = async (deadline) => {
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      return true;
    } catch {
      try {
        const other = Number(readFileSync(join(lockDir, "pid"), "utf8"));
        process.kill(other, 0); // alive: wait
      } catch {
        rmSync(lockDir, { recursive: true, force: true }); // its owner is gone
        continue;
      }
      if (Date.now() > deadline) return false;
      await sleep(1000);
    }
  }
};
let restoreTo = null;
if (args.includes("--polite")) {
  const deadline = Date.now() + maxWait;
  let told = false;
  while (idleSeconds() < idleNeed) {
    if (Date.now() > deadline) {
      console.error(
        `skipped: you stayed active for ${maxWait / 1000} s, so no window was opened (nothing steals your focus). Run again when you are away, or add --now.`,
      );
      process.exit(3);
    }
    if (!told)
      console.error(`waiting until you have been idle for ${idleNeed} s before opening a window (--now skips this)`);
    told = true;
    await sleep(2000);
  }
  if (!(await takeLock(deadline))) {
    console.error("skipped: another window run holds the lock");
    process.exit(3);
  }
  restoreTo = frontBundle();
}
const release = () => {
  rmSync(lockDir, { recursive: true, force: true });
  if (restoreTo && !restoreTo.includes("nsh")) spawnSync("open", ["-b", restoreTo], { stdio: "ignore" });
};
// Default: the no-focus library, one window run at a time.
const interpose = !args.includes("--polite") && !args.includes("--no-interpose");
let dylib = null;
if (interpose) {
  dylib = join(root, ".scratch", "no-focus", "no_focus.dylib");
  if (!existsSync(dylib)) spawnSync("sh", [join(root, "scripts", "no-focus", "build.sh")], { stdio: "inherit" });
  if (!(await takeLock(Date.now() + maxWait))) {
    console.error("skipped: another window run holds the lock");
    process.exit(3);
  }
}
process.on("exit", () => {
  if (interpose || args.includes("--polite")) release();
});

const child = spawn("nsh", ["test", testRel, "--target", "macos"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HERDR_DESKTOP_TEST: "1",
    // The terminal feature builds libghostty-vt with zig (docs/DEVELOPMENT.md "Building the terminal").
    LIBGHOSTTY_VT_SYS_CPU: "baseline",
    PATH: [join(root, ".scratch/zigenv"), join(root, ".scratch/zig"), process.env.PATH].join(":"),
    ...(dylib && existsSync(dylib)
      ? { DYLD_INSERT_LIBRARIES: [dylib, process.env.DYLD_INSERT_LIBRARIES].filter(Boolean).join(":") }
      : {}),
  },
});
const timer = setTimeout(() => {
  console.error(`timeout: killing pid ${child.pid} (the nsh this script started)`);
  child.kill("SIGTERM");
}, timeout);
child.on("exit", (code) => {
  clearTimeout(timer);
  for (const t of themes)
    console.log(existsSync(join(root, pngFor(t))) ? `wrote ${pngFor(t)}` : `missing ${pngFor(t)}`);
  process.exit(code ?? 1);
});
