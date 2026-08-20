"""Fail fast when a UTF-8 source file contains common mojibake markers."""

from pathlib import Path

MARKERS = ("\u00c3", "\u00c2", "\u00e0\u00b8", "\u00e0\u00b9", "\u00e2\u201a", "\u00f0\u0178")
ROOTS = (Path("backend"), Path("frontend/src"), Path("scripts"))
EXTENSIONS = {".go", ".ts", ".tsx", ".css", ".py"}

failures: list[str] = []
for root in ROOTS:
    for path in root.rglob("*"):
        if path.suffix not in EXTENSIONS or "node_modules" in path.parts or path.name == "check_source_encoding.py":
            continue
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), 1):
            if any(marker in line for marker in MARKERS):
                failures.append(f"{path}:{line_number}")

if failures:
    raise SystemExit("mojibake markers found: " + ", ".join(failures))

print("source encoding check: ok")
