// Checks the notes of one version in CHANGELOG.md against the format of `.agents/skills/herdr-changelog/SKILL.md`.
//
//   node scripts/check-changelog.mjs 0.1.0-alpha.4     # a release: the section `## [0.1.0-alpha.4]`
//   node scripts/check-changelog.mjs unreleased        # a feat or fix change: the bullets under `## [Unreleased]`
//
// What it can check: the section exists and is not empty; `###` headlines; at most 3 `> [!TIP]` cards, each with a `> Try it:`
// line; no commit hashes, PR numbers, file names or source paths outside backticks; lines wrapped at 80 characters; media
// are release assets (`https://github.com/<repo>/releases/download/v<version>/<version>-<slug>.png|jpg|mp4`) with a
// description of 4 words or more, never a file of the repository. What it cannot: that a bullet is true, that every
// commit is covered, that a tip's path works (read them: the skill, section 3).
import { readFileSync } from "node:fs";

const REPO = "tuan3w/herdr-desktop";
const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/check-changelog.mjs <version>|unreleased");
  process.exit(64);
}
const unreleased = arg === "unreleased";
const heading = unreleased ? "## [Unreleased]" : `## [${arg}]`;

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(heading));
if (start < 0) {
  console.error(`check-changelog: CHANGELOG.md has no '${heading}'`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
if (end < 0) end = lines.length;
const section = lines.slice(start + 1, end);
if (!section.some((l) => l.trim())) {
  console.error(`check-changelog: '${heading}' is empty`);
  process.exit(1);
}

const problems = [];
const bad = (n, msg) => problems.push(`CHANGELOG.md:${start + 2 + n}: ${msg}`);

let fenced = false;
let tips = 0;
let headlines = 0;
section.forEach((raw, n) => {
  if (raw.startsWith("```")) {
    fenced = !fenced;
    return;
  }
  if (fenced) return;
  const line = raw.trimEnd();
  if (line.startsWith("### ")) headlines++;
  if (line.startsWith("## ")) bad(n, "a second `## ` heading inside the section");

  if (line.startsWith("> [!TIP]")) {
    tips++;
    if (!(section[n + 1] ?? "").startsWith("> Try it:")) bad(n, "a `> [!TIP]` card must continue with `> Try it: ...`");
  }

  // Text without inline code: names in backticks are labels and commands, and may look like anything.
  const prose = line.replace(/`[^`]*`/g, "``").replace(/\]\([^)]*\)/g, "]()");
  for (const word of prose.match(/\b[0-9a-f]{7,40}\b/g) ?? []) {
    if (/[0-9]/.test(word) && /[a-f]/.test(word)) bad(n, `a commit hash (${word})`);
  }
  if (/(^|[\s(])#[0-9]{1,5}\b/.test(prose)) bad(n, "a PR or issue number");
  if (/\b[\w-]+\.(rs|tsx?|mjs|py|sh|ya?ml|toml|json)\b/.test(prose)) bad(n, "a file name: say what the person sees");
  if (/\b(lib|components|native|scripts)\//.test(prose)) bad(n, "a source path");
  if (/\brefactor/i.test(prose)) bad(n, 'the word "refactor"');

  const media = /!\[([^\]]*)\]\(([^)]*)\)/g;
  for (const m of line.matchAll(media)) {
    const [, alt, url] = m;
    if (alt.trim().split(/\s+/).length < 4) bad(n, `the description of a picture needs 4 words or more: '${alt}'`);
    if (unreleased) continue;
    const ok = new RegExp(
      `^https://github\\.com/${REPO}/releases/download/v${arg.replace(/[.]/g, "\\.")}/${arg.replace(/[.]/g, "\\.")}-[a-z0-9]+(-[a-z0-9]+)*\\.(png|jpg|mp4)$`,
    );
    if (!ok.test(url))
      bad(n, `a picture is a release asset <releases/download/v${arg}/${arg}-<slug>.png|jpg|mp4>, not '${url}'`);
  }

  const wrapped = line.startsWith("#") || line.startsWith("|") || /!\[|https?:\/\//.test(line);
  if (!wrapped && line.length > 80) bad(n, `${line.length} characters: wrap at about 78`);
});

if (tips > 3) problems.push(`CHANGELOG.md: ${tips} Try-it cards in ${heading}, at most 3`);
if (!unreleased && headlines === 0) problems.push(`CHANGELOG.md: '${heading}' has no \`### headline\``);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check-changelog: ${heading} ok (${headlines} headlines, ${tips} tips)`);
