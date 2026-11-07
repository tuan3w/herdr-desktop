/**
 * What a ```` ```mermaid ```` block needs that is not a screen: the page the web view loads, a title for the diagram, and the
 * answer the page posts back. The page has no network: its policy allows the one script (the bundled mermaid, served from
 * this process's loopback listener, `Diagrams.origin`), inline script and style, and `data:` images, nothing else, so a
 * diagram cannot fetch, post or load anything whatever its source says.
 */

const KINDS: Record<string, string> = {
  flowchart: "flowchart",
  graph: "flowchart",
  sequenceDiagram: "sequence diagram",
  classDiagram: "class diagram",
  stateDiagram: "state diagram",
  "stateDiagram-v2": "state diagram",
  erDiagram: "entity relationship diagram",
  gantt: "gantt chart",
  pie: "pie chart",
  journey: "user journey",
  gitGraph: "git graph",
  mindmap: "mind map",
  timeline: "timeline",
  quadrantChart: "quadrant chart",
  requirementDiagram: "requirement diagram",
  sankey: "sankey diagram",
  xychart: "chart",
};

/**
 * `Diagram: <title>`: the title the source gives (front matter `title:`, or a `title` line), else the kind of diagram it
 * declares (`flowchart`, `sequence diagram`), else just `diagram`. This is the diagram's accessible name and the label
 * above it: the source under `Show source` is its text alternative.
 */
export function diagramTitle(code: string): string {
  const front = /^\s*---\s*\n([\s\S]*?)\n---/.exec(code);
  const named = front ? /^\s*title:\s*["']?(.+?)["']?\s*$/m.exec(front[1]) : null;
  if (named) return `Diagram: ${named[1]}`;
  const body = front ? code.slice(front[0].length) : code;
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("%%"));
  const titled = lines.find((l) => /^title\s+\S/.test(l));
  if (titled) return `Diagram: ${titled.replace(/^title\s+/, "")}`;
  const word = lines[0]?.split(/[\s;{]/)[0] ?? "";
  return `Diagram: ${KINDS[word] ?? "diagram"}`;
}

/** Text for an HTML text node: the only characters that can end it or start markup. */
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** JSON for inside a `<script>`: `<` never appears raw, so no value can close the script or open a comment. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The colours the page takes from the app's theme, as CSS colours. */
export interface DiagramColors {
  background: string;
  text: string;
  line: string;
  fill: string;
  border: string;
}

/** The page that draws `code`. The source travels as text in a hidden element (escaped), never as script. */
export function diagramPage(options: { origin: string; code: string; title: string; dark: boolean; colors: DiagramColors }): string {
  const { origin, code, title, dark, colors } = options;
  const variables = {
    background: colors.background,
    primaryColor: colors.fill,
    primaryTextColor: colors.text,
    primaryBorderColor: colors.border,
    lineColor: colors.line,
    secondaryColor: colors.fill,
    tertiaryColor: colors.background,
    textColor: colors.text,
    noteBkgColor: colors.fill,
    noteTextColor: colors.text,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>html,body{margin:0;background:${colors.background};color:${colors.text};font:13px sans-serif}#out{padding:8px;display:flex;justify-content:center}svg{display:block;max-width:none}</style>
</head><body><div id="out" role="img" aria-label="${escapeHtml(title).replace(/"/g, "&quot;")}"></div><pre id="src" hidden>${escapeHtml(code)}</pre>
<script src="${origin}/mermaid.min.js"></script>
<script>
(function () {
  var post = function (o) { try { window.nsh.postMessage(JSON.stringify(o)); } catch (e) {} };
  if (!window.mermaid) { post({ ok: false, message: "The diagram script did not load" }); return; }
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${dark ? '"dark"' : '"base"'}, themeVariables: ${scriptJson(variables)}, flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false } });
  mermaid.render("diagram", document.getElementById("src").textContent).then(function (r) {
    var out = document.getElementById("out");
    out.innerHTML = r.svg;
    var page = document.documentElement;
    post({ ok: true, w: page.scrollWidth, h: page.scrollHeight });
  }).catch(function (e) {
    var leftover = document.getElementById("ddiagram"); if (leftover) leftover.remove();
    post({ ok: false, message: String((e && e.message) || e).split("\\n")[0] });
  });
})();
</script></body></html>`;
}

/** What the page posts: how big the drawing is, or why it could not be drawn. */
export type DiagramResult = { ok: true; w: number; h: number } | { ok: false; message: string };

/** The page's message, or `null` for anything that is not one. */
export function parseDiagramResult(data: string): DiagramResult | null {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (value.ok === true && typeof value.w === "number" && typeof value.h === "number") return { ok: true, w: value.w, h: value.h };
    if (value.ok === false && typeof value.message === "string") return { ok: false, message: value.message };
  } catch {
    // not ours
  }
  return null;
}
