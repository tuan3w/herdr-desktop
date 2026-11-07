// The mechanical form of "docs change with the code": DESIGN.md < 100 lines, each design/*.md < 150, and every
// backticked identifier in them exists somewhere in the code. Prose terms that are not code go in docs-allow.txt.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SOURCES = ["components", "lib", "native", "scripts", "App.tsx", "nsh.json"];
const SKIP_DIRS = new Set(["node_modules", "target", ".nsh", ".git", ".scratch"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;

const allow = new Set(
  existsSync(join(root, "scripts/docs-allow.txt"))
    ? readFileSync(join(root, "scripts/docs-allow.txt"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [],
);

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) return yield path;
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

let corpus = "";
for (const src of SOURCES) {
  const p = join(root, src);
  if (!existsSync(p)) continue;
  for (const file of walk(p)) {
    if (/\.(png|svg|ttf|otf|woff2?|ico|json)$/.test(file) && !file.endsWith("nsh.json")) continue;
    corpus += readFileSync(file, "utf8") + "\n";
  }
}

const docs = [["DESIGN.md", 100]];
if (existsSync(join(root, "design"))) {
  for (const f of readdirSync(join(root, "design")).sort()) if (f.endsWith(".md")) docs.push([`design/${f}`, 150]);
}

const problems = [];
for (const [file, limit] of docs) {
  const text = readFileSync(join(root, file), "utf8");
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (lines >= limit) problems.push(`${file}: ${lines} lines, the limit is under ${limit}`);
  const seen = new Set();
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    // `Foo()` and `Foo.bar()` name `Foo` and `Foo.bar`; dotted names are searched whole, then by their last part.
    const name = token.replace(/\(\)$/, "");
    if (!IDENT.test(name) || seen.has(name) || allow.has(name)) continue;
    seen.add(name);
    const parts = name.split(".");
    if (!corpus.includes(name) && !corpus.includes(parts[parts.length - 1])) {
      problems.push(`${file}: \`${name}\` does not exist in ${SOURCES.join(", ")}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`docs ok (${docs.length} files)`);
