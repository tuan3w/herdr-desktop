#!/bin/sh
# Generates fixtures/files/viewers: one small synthetic file of each kind the file viewers show besides text and media
# (a PDF, archives, a table, minified JSON, an SVG, a log, a binary). Nothing here is real data. Needs python3, zip, tar.
set -eu
out="${1:-fixtures/files/viewers}"
rm -rf "$out"
mkdir -p "$out"
python3 - "$out" <<'PY'
import json, struct, sys, zlib

out = sys.argv[1]

# A one-page PDF with a line of text (hand written: objects, xref and trailer).
text = b"BT /F1 24 Tf 72 700 Td (Herdr test document) Tj ET"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
pdf = b"%PDF-1.4\n"
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(pdf))
    pdf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offsets:
    pdf += b"%010d 00000 n \n" % off
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(out + "/report.pdf", "wb").write(pdf)

open(out + "/logo.svg", "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">'
    '<rect width="160" height="100" rx="12" fill="#2b6cb0"/><circle cx="50" cy="50" r="28" fill="#fbd38d"/>'
    '<rect x="92" y="30" width="48" height="12" fill="#fff"/><rect x="92" y="54" width="32" height="12" fill="#fff"/></svg>\n'
)

rows = ["name,owner,status,minutes"]
for i in range(1, 25):
    rows.append(f'task-{i:02d},"{["Ada", "Lin", "Sam", "Noor"][i % 4]}, team {i % 3}",{["done", "working", "blocked"][i % 3]},{i * 7 % 60}')
open(out + "/table.csv", "w").write("\n".join(rows) + "\n")

doc = {"name": "herdr-demo", "version": "1.2.3", "id": 12345678901234567890,
       "agents": [{"id": i, "kind": ["omp", "claude", "codex"][i % 3], "tags": ["a", "b"], "meta": {"cwd": f"/work/app{i}", "ok": i % 2 == 0}} for i in range(6)],
       "limits": {"tokens": 200000, "ratio": 0.25, "empty": {}, "none": None}}
open(out + "/config.json", "w").write(json.dumps(doc, separators=(",", ":")) + "\n")

log = []
for i in range(300):
    level = ["INFO", "INFO", "WARN", "INFO", "ERROR"][i % 5]
    log.append(f"2026-11-07T10:{i // 60:02d}:{i % 60:02d}Z {level} worker-{i % 4} handled request {i} in {i * 3 % 90} ms")
open(out + "/server.log", "w").write("\n".join(log) + "\n")

blob = bytearray(b"\x7fELF\x02\x01\x01\x00") + bytes((i * 7 + 3) % 256 for i in range(6000))
open(out + "/tool.bin", "wb").write(blob)
PY
mkdir -p "$out/.tree/src" "$out/.tree/assets"
printf 'fn main() {\n    println!("hello");\n}\n' > "$out/.tree/src/main.rs"
printf '# Bundle\n\nA synthetic archive.\n' > "$out/.tree/README.md"
cp "$out/logo.svg" "$out/.tree/assets/logo.svg"
(cd "$out/.tree" && zip -q -r -X ../bundle.zip README.md src assets)
(cd "$out/.tree" && tar --sort=name --mtime='2026-01-01 00:00Z' --owner=0 --group=0 -czf ../bundle.tar.gz README.md src assets)
rm -rf "$out/.tree"
ls -l "$out"
