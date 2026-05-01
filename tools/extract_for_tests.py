"""
Extract text from each sample PDF and dump as JSON for the parser tests.

Mimics what `src/core/pdf-loader.js` produces in the browser: every line
is grouped by y-coordinate (tol=3 px), giving the JS template parsers
the same shape they'd see at runtime.

Run once after touching the sample PDFs:
    python3 tools/extract_for_tests.py

Requires:  pdfplumber   (`pip install pdfplumber`)
"""
import json, re, sys
from collections import defaultdict
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    print("ERROR: pdfplumber not installed. Try `pip install pdfplumber`.",
          file=sys.stderr)
    sys.exit(2)

ROOT     = Path(__file__).resolve().parent.parent
SAMPLES  = ROOT / "samples"
OUT_DIR  = ROOT / "tests" / "fixtures"
OUT_FILE = OUT_DIR / "extracted-pdfs.json"
OUT_DIR.mkdir(parents=True, exist_ok=True)

NAMES = ["n26-statement.pdf", "santander-statement.pdf",
         "ing-statement.pdf", "leumi-statement.pdf"]
# (activo-statement.pdf was replaced by activo-statement.csv — no need to extract.)

def extract(path, tol=3):
    """Group glyphs into y-buckets to recover visible lines."""
    pages = []
    all_lines = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            buckets = []
            for ch in page.chars:
                placed = False
                for b in buckets:
                    if abs(b["y"] - ch["y0"]) <= tol:
                        b["chars"].append(ch); placed = True; break
                if not placed:
                    buckets.append({"y": ch["y0"], "chars": [ch]})
            buckets.sort(key=lambda b: -b["y"])
            lines = []
            for b in buckets:
                b["chars"].sort(key=lambda c: c["x0"])
                parts, last = [], None
                for c in b["chars"]:
                    if last is not None and c["x0"] - last["x1"] > 1.0:
                        parts.append(" ")
                    parts.append(c["text"])
                    last = c
                line = re.sub(r"\s+", " ", "".join(parts)).strip()
                if line:
                    lines.append(line)
            pages.append({"lines": lines})
            all_lines.extend(lines)
    return {"pages": pages, "textAll": "\n".join(all_lines)}

out = {}
for name in NAMES:
    path = SAMPLES / name
    if not path.exists():
        print(f"  ⚠ skipping {name} (missing)", file=sys.stderr)
        continue
    out[name] = extract(path)
    print(f"  ✓ {name} ({len(out[name]['pages'])} pages, "
          f"{sum(len(p['lines']) for p in out[name]['pages'])} lines)")

OUT_FILE.write_text(json.dumps(out, ensure_ascii=False))
print(f"wrote {OUT_FILE}")
