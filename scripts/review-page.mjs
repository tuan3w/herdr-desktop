// Builds `.scratch/shots/index.html`, a page to review the screenshots of `make shots` in a browser, a phone included: one
// section per scenario, light and dark side by side at each width (one column on a phone), a mode bar (side by side, light,
// dark, tap to flip between the two), a width filter, a scenario jump list and a search; the choice is remembered. Click an
// image to see it large (in flip mode a tap flips instead, and `open` in its caption enlarges it). The shots come from the scripted
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
const cell = (f, label, scheme) =>
  f
    ? `<figure class="${scheme}"><img loading="lazy" decoding="async" src="${esc(f)}" alt="${esc(label)}"><span class="badge">${scheme}</span><figcaption><span>${esc(label)}</span><button class="open" data-src="${esc(f)}" aria-label="Open ${esc(label)} large">open</button></figcaption></figure>`
    : `<figure class="missing ${scheme}">no ${scheme} shot</figure>`;

// `--focus a,b,c` names the scenarios this release changed: the page gets a `Changed` filter that lists only those first.
const focusArg = process.argv.find((a) => a.startsWith("--focus="))?.slice(8) ?? "";
const FOCUS = new Set(focusArg.split(",").filter(Boolean));

const ordered = [...names.filter((n) => FOCUS.has(n)), ...names.filter((n) => !FOCUS.has(n))];
const sections = ordered
  .map((name) => {
    const shots = byScenario.get(name);
    const rows = WIDTHS.filter((w) => shots.has(`light-${w}`) || shots.has(`dark-${w}`))
      .map(
        (w) =>
          `<div class="row" data-w="${w}"><h3>${w} px</h3><div class="pair">${cell(shots.get(`light-${w}`), `${name} light ${w}`, "light")}${cell(shots.get(`dark-${w}`), `${name} dark ${w}`, "dark")}</div></div>`,
      )
      .join("");
    return `<section id="${esc(name)}" data-name="${esc(name)}"${FOCUS.has(name) ? ' data-focus="1"' : ""}><h2>${esc(name)}${FOCUS.has(name) ? ' <span class="tag">changed</span>' : ""}</h2>${rows}</section>`;
  })
  .join("\n");
const options = ordered
  .map((n) => `<option value="${esc(n)}">${FOCUS.has(n) ? "\u2605 " : ""}${esc(n)}</option>`)
  .join("");

writeFileSync(
  `${dir}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>herdr-desktop screenshots</title>
<style>
:root{color-scheme:light dark;--bg:#f4f3ef;--fg:#222;--card:#fff;--line:#ddd;--muted:#666;--accent:#0b6b6b;--on:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#161512;--fg:#eee;--card:#22211e;--line:#3a3834;--muted:#a09d96;--accent:#5cc6c6;--on:#0d2b2b}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{font:15px system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%}
button{font:inherit;color:inherit}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 12px;display:grid;gap:8px}
header h1{font-size:15px;margin:0;font-weight:600}header h1 small{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:2px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{font-size:13px;border:0;border-right:1px solid var(--line);background:transparent;padding:8px 12px;min-height:40px}
.seg button:last-child{border-right:0}.seg button[aria-pressed=true]{background:var(--accent);color:var(--on);font-weight:600}
select,input{font:inherit;font-size:16px;min-height:40px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);padding:0 8px;min-width:0}
select{flex:1 1 160px}input{flex:1 1 120px}
.now{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;background:var(--card);border-bottom:1px solid var(--line);padding:0 8px 0 12px;height:44px}
.now b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.now button{border:1px solid var(--line);border-radius:8px;background:transparent;min-height:36px;padding:0 12px;font-size:13px}
.now button[aria-pressed=true]{background:var(--accent);color:var(--on);border-color:var(--accent)}
main{padding:12px;max-width:1500px;margin:auto}
section{margin:0 0 40px;scroll-margin-top:52px}h2{border-bottom:1px solid var(--line);padding-bottom:4px;font-size:18px;margin:0 0 4px}
.tag{font-size:11px;font-weight:600;background:var(--accent);color:var(--on);border-radius:10px;padding:2px 8px;vertical-align:middle;margin-left:6px}
h3{font-size:13px;margin:12px 0 6px;color:var(--muted);font-weight:600}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px;position:relative}
figure img{width:100%;height:auto;display:block;background:#888;border-radius:4px;min-height:60px}
.badge{position:absolute;top:12px;left:12px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:10px;padding:2px 8px;background:rgba(255,255,255,.92);color:#222;box-shadow:0 0 0 1px rgba(0,0,0,.2)}
figure.dark .badge{background:rgba(20,20,20,.92);color:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.35)}
figcaption{font-size:12px;color:var(--muted);margin-top:4px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.open{border:0;background:transparent;color:var(--accent);padding:8px 4px;min-height:36px;font-size:13px;text-decoration:underline}
.missing{padding:24px;text-align:center;color:var(--muted)}
body[data-mode=light] .dark,body[data-mode=dark] .light{display:none}
body[data-mode=light] .pair,body[data-mode=dark] .pair,body[data-mode=flip] .pair{grid-template-columns:1fr}
body[data-mode=flip] .pair figure.dark{display:none}
body[data-mode=flip] .pair.flipped figure.light{display:none}
body[data-mode=flip] .pair.flipped figure.dark{display:block}
body[data-mode=flip] .pair figure img{cursor:pointer;-webkit-tap-highlight-color:transparent}
.hidden{display:none!important}
.empty{padding:40px 12px;text-align:center;color:var(--muted)}
@media(max-width:700px){.pair{grid-template-columns:1fr}main{padding:8px}header .seg button{padding:8px 10px}}
.pager{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;z-index:3}
.pager button{width:48px;height:48px;border-radius:24px;border:1px solid var(--line);background:var(--card);font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
#lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.97);z-index:10;overflow:auto;touch-action:pan-x pan-y pinch-zoom;padding:52px 8px 12px}
#lb.on{display:block}#lb img{width:100%;max-width:none;display:block;margin:auto;background:#888}
#lb .x{position:fixed;top:8px;right:8px;width:44px;height:44px;border-radius:22px;border:0;background:rgba(255,255,255,.9);color:#222;font-size:22px;z-index:11}
#lb .cap{position:fixed;top:0;left:0;right:60px;height:60px;display:flex;align-items:center;padding:0 12px;color:#fff;font-size:13px;z-index:11;pointer-events:none}
@media(min-width:900px){#lb img{width:auto}}
</style>
<header id="head"><h1>herdr-desktop screenshots <small>${files.length} images, ${names.length} scenarios &middot; real GTK window, scripted data only${FOCUS.size ? ` &middot; ${FOCUS.size} changed in this release` : ""}</small></h1>
<div class="bar"><div class="seg" id="mode" role="group" aria-label="Theme view"><button data-v="pair">Side by side</button><button data-v="light">Light</button><button data-v="dark">Dark</button><button data-v="flip">Tap to flip</button></div>
<div class="seg" id="width" role="group" aria-label="Width"><button data-v="all">All</button><button data-v="1280">1280</button><button data-v="960">960</button><button data-v="760">760</button></div>
${FOCUS.size ? '<div class="seg" id="scope" role="group" aria-label="Which scenarios"><button data-v="changed">Changed</button><button data-v="all">All scenarios</button></div>' : ""}</div>
<div class="bar"><select id="jump" aria-label="Jump to a scenario"><option value="">Jump to a scenario (${names.length})</option>${options}</select><input id="find" type="search" placeholder="Filter by name" aria-label="Filter scenarios by name"></div></header>
<div class="now"><b id="here">${esc(ordered[0] ?? "")}</b><button id="flipnow" aria-pressed="false" aria-label="Show the other theme">Show dark</button></div>
<main>${sections}<p class="empty hidden" id="none">No scenario matches.</p></main>
<div class="pager"><button id="prev" aria-label="Previous scenario">&uarr;</button><button id="next" aria-label="Next scenario">&darr;</button></div>
<div id="lb" role="dialog" aria-label="Screenshot"><button class="x" aria-label="Close">&times;</button><div class="cap"></div><img alt=""></div>
<script>
const $ = (s) => document.querySelector(s), all = (s) => [...document.querySelectorAll(s)];
const store = { get: (k, d) => { try { return localStorage.getItem("shots." + k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("shots." + k, v); } catch {} } };
const phone = matchMedia("(max-width:700px)").matches;
const state = { query: "", scope: store.get("scope", "changed") };
const setSeg = (id, attr, value) => { document.body.dataset[attr] = value; all("#" + id + " button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === value))); };
const flipLabel = (on) => { const b = $("#flipnow"); b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "Show light" : "Show dark"; };
const applyMode = (v) => { setSeg("mode", "mode", v); store.set("mode", v); all(".pair").forEach((p) => p.classList.remove("flipped")); flipLabel(false); $("#flipnow").hidden = v !== "flip"; };
const applyWidth = (v) => { setSeg("width", "width", v); store.set("width", v); all(".row").forEach((r) => r.classList.toggle("hidden", v !== "all" && r.dataset.w !== v)); };
const applyFilter = () => {
  let n = 0;
  all("section").forEach((s) => { const show = (state.scope === "all" || s.dataset.focus) && (!state.query || s.dataset.name.includes(state.query)); s.classList.toggle("hidden", !show); if (show) n++; });
  $("#none").classList.toggle("hidden", n > 0);
};
$("#mode").onclick = (e) => e.target.dataset.v && applyMode(e.target.dataset.v);
$("#width").onclick = (e) => e.target.dataset.v && applyWidth(e.target.dataset.v);
if ($("#scope")) { setSeg("scope", "scope", state.scope); $("#scope").onclick = (e) => { if (!e.target.dataset.v) return; state.scope = e.target.dataset.v; store.set("scope", state.scope); setSeg("scope", "scope", state.scope); applyFilter(); }; } else state.scope = "all";
applyMode(store.get("mode", phone ? "flip" : "pair"));
applyWidth(store.get("width", phone ? "760" : "all"));
applyFilter();
$("#find").oninput = (e) => { state.query = e.target.value.trim().toLowerCase(); applyFilter(); };
$("#jump").onchange = (e) => { const t = e.target.value && document.getElementById(e.target.value); if (t) { state.query = ""; $("#find").value = ""; applyFilter(); t.scrollIntoView({ block: "start" }); } e.target.value = ""; };
// The slim bar names the scenario in view; its button flips the one in view, so a comparison needs no scrolling back.
const here = new Map();
const io = new IntersectionObserver((es) => { es.forEach((e) => here.set(e.target, e.isIntersecting)); const top = all("section").find((s) => here.get(s)); if (top) $("#here").textContent = top.dataset.name; }, { rootMargin: "-50px 0px -70% 0px" });
all("section").forEach((s) => io.observe(s));
const current = () => all("section").find((s) => here.get(s) && !s.classList.contains("hidden"));
$("#flipnow").onclick = () => { const s = current(); if (!s) return; const pairs = [...s.querySelectorAll(".row:not(.hidden) .pair")]; const to = !pairs[0]?.classList.contains("flipped"); pairs.forEach((p) => p.classList.toggle("flipped", to)); flipLabel(to); };
// One lightbox for every picture: nothing but the pictures on screen is fetched.
const lb = $("#lb"), lbImg = $("#lb img"), lbCap = $("#lb .cap");
const openLb = (src, alt) => { lbImg.src = src; lbImg.alt = alt || ""; lbCap.textContent = alt || ""; lb.classList.add("on"); lb.scrollTop = 0; if (history.state !== "lb") history.pushState("lb", ""); };
const closeLb = () => { if (!lb.classList.contains("on")) return; lb.classList.remove("on"); lbImg.removeAttribute("src"); if (history.state === "lb") history.back(); };
lb.onclick = (e) => { if (e.target === lb || e.target.classList.contains("x")) closeLb(); };
addEventListener("popstate", () => { lb.classList.remove("on"); lbImg.removeAttribute("src"); });
addEventListener("keydown", (e) => { if (e.key === "Escape") closeLb(); });
document.addEventListener("click", (e) => {
  const open = e.target.closest(".open"); if (open) return openLb(open.dataset.src, open.getAttribute("aria-label").replace(/^Open | large$/g, ""));
  const img = e.target.closest("figure img"); if (!img) return;
  if (document.body.dataset.mode === "flip") { img.closest(".pair").classList.toggle("flipped"); flipLabel(img.closest(".pair").classList.contains("flipped")); } else openLb(img.getAttribute("src"), img.alt);
});
const visible = () => all("section").filter((s) => !s.classList.contains("hidden"));
const step = (d) => { const list = visible(); if (!list.length) return; const y = scrollY + 56; const at = list.findIndex((s) => s.offsetTop + s.offsetHeight > y + 4); const i = Math.min(Math.max((at < 0 ? list.length - 1 : at) + (d > 0 ? (list[at]?.offsetTop > y + 4 ? 0 : 1) : (list[at]?.offsetTop < y - 4 ? 0 : -1)), 0), list.length - 1); list[i].scrollIntoView({ block: "start" }); };
$("#prev").onclick = () => step(-1); $("#next").onclick = () => step(1);
</script></html>`,
);
console.log(`${dir}/index.html: ${names.length} scenarios, ${files.length} images`);
