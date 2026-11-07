// Builds `.scratch/shots/index.html`, a page to review the screenshots of `make shots` in a browser: one section per
// scenario, light and dark side by side at each width, click an image to see it large. The shots come from the scripted
// fixtures only (never a real pane). Serve it with `python3 -m http.server -d .scratch/shots 8765`.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const dir = `${root}.scratch/shots`;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".png"))
  .sort();
const WIDTHS = [1280, 960, 760];
const byScenario = new Map();
for (const f of files) {
  const m = f.match(/^(.+)-(light|dark)-(\d+)\.png$/);
  if (!m) continue;
  const [, name, scheme, width] = m;
  if (!byScenario.has(name)) byScenario.set(name, new Map());
  byScenario.get(name).set(`${scheme}-${width}`, f);
}

// The order and the one-line description come from the scenario list, so a new scenario shows up with its name.
const source = existsSync(`${root}.shots/scenarios.ts`) ? readFileSync(`${root}.shots/scenarios.ts`, "utf8") : "";
const order = [...source.matchAll(/^\s{2}(?:"([a-z0-9-]+)"|([a-z0-9]+)):\s*\{/gm)].map((m) => m[1] ?? m[2]);
const names = [...byScenario.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cell = (f, label) =>
  f
    ? `<figure><a href="#${esc(f)}"><img loading="lazy" src="${esc(f)}" alt="${esc(label)}"></a><figcaption>${esc(label)}</figcaption></figure><a class="lightbox" id="${esc(f)}" href="#"><img src="${esc(f)}" alt="${esc(label)} (large)"></a>`
    : `<figure class="missing">no shot</figure>`;

const sections = names
  .map((name) => {
    const shots = byScenario.get(name);
    const rows = WIDTHS.map(
      (w) =>
        `<div class="row"><h3>${w} px</h3><div class="pair">${cell(shots.get(`light-${w}`), `${name} light ${w}`)}${cell(shots.get(`dark-${w}`), `${name} dark ${w}`)}</div></div>`,
    ).join("");
    return `<section id="${esc(name)}"><h2>${esc(name)}</h2>${rows}</section>`;
  })
  .join("\n");
const nav = names.map((n) => `<a href="#${esc(n)}">${esc(n)}</a>`).join(" ");

writeFileSync(
  `${dir}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>herdr-desktop screenshots</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#f4f3ef;color:#222}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 20px;z-index:2}
header h1{font-size:16px;margin:0 0 6px}
nav a{display:inline-block;margin:2px 8px 2px 0;color:#0b6b6b;text-decoration:none}
main{padding:20px;max-width:1500px;margin:auto}
section{margin:0 0 48px}h2{border-bottom:1px solid #ccc;padding-bottom:4px}
h3{font-size:13px;margin:12px 0 6px;color:#666;font-weight:600}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:6px;padding:6px}
figure img{width:100%;height:auto;display:block}figcaption{font-size:12px;color:#666;margin-top:4px}
.lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10;overflow:auto;padding:20px}
.lightbox:target{display:block}.lightbox img{max-width:none;display:block;margin:auto}
</style>
<header><h1>herdr-desktop &mdash; ${files.length} screenshots of the real GTK window (Xvfb, cairo), scripted data only</h1><nav>${nav}</nav></header>
<main>${sections}</main></html>`,
);
console.log(`${dir}/index.html: ${names.length} scenarios, ${files.length} images`);
