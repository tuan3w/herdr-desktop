// How the scripts start `nsh test --target linux`: on the person's display when `DISPLAY` or `WAYLAND_DISPLAY` is set
// (real frame numbers), else under Xvfb with the cairo renderer (CPU-rendered: fine for counts and ratios, not for frame
// times). The GTK dev files come from the system, or from `.scratch/sysroot/env.sh` when that exists (docs/DEVELOPMENT.md).
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

/** True when the numbers come from a real display, not Xvfb. */
export const realDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** The shell command that runs `nsh test <file> --target linux <extra>`. */
export function nshTest(file, extra = "") {
  const sysroot = existsSync(`${root}.scratch/sysroot/env.sh`) ? `. ${root}.scratch/sysroot/env.sh && ` : "";
  const test = `HERDR_DESKTOP_TEST=1 exec nsh test ${file} --target linux ${extra}`;
  const wrapped = realDisplay
    ? test
    : `dbus-run-session -- xvfb-run -a env GSK_RENDERER=cairo GTK_A11Y=atspi sh -c '${test}'`;
  return `cd ${root} && ${sysroot}${wrapped}`;
}
