#!/usr/bin/env python3
"""Verify the import graph closes.

Scans every vendored file and every js/*.js file for import specifiers, then
resolves each one: bare specifiers through the import map in index.html,
relative specifiers against the importing file. Exits non-zero on any miss.

Usage: python3 tools/check_imports.py
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Matches `import ... from "x"`, `import "x"`, `export ... from "x"`.
# \b after import/export and a specifier class without spaces or colons are
# both required: without them, keyword tables and doc comments inside the
# vendored bundles parse as import statements.
IMPORT_RE = re.compile(
    r"""(?:^|[\s;}])(?:import|export)\b\s*(?:[\w*{},\s$]*?\s*from\s*)?["']((?:@|\.{0,2}/|\w)[^"'\s:]*)["']""",
    re.M,
)

IMPORTMAP_RE = re.compile(
    r'<script\s+type="importmap"\s*>(.*?)</script>', re.S | re.I
)

# Dynamic `import("x")`. These only mark an import map entry as used; they are
# not resolved, because vendored bundles carry Node-only branches such as
# `import("fs")` that never run in the browser and would report a false miss.
DYNAMIC_IMPORT_RE = re.compile(r"""\bimport\(\s*["']([^"'\s]+)["']\s*\)""")


def load_import_map():
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    match = IMPORTMAP_RE.search(html)
    if not match:
        raise SystemExit("no <script type=\"importmap\"> found in index.html")
    return json.loads(match.group(1))["imports"]


def source_files():
    files = []
    for base in ("vendor", "js"):
        for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, base)):
            for name in sorted(filenames):
                if name.endswith(".js"):
                    files.append(os.path.join(dirpath, name))
    return sorted(files)


def resolve(spec, importer, imports):
    if spec.startswith("."):
        return os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    target = imports.get(spec)
    if target is None:
        return None
    return os.path.normpath(os.path.join(ROOT, target))


def main():
    imports = load_import_map()
    files = source_files()
    misses = []
    used = set()
    total = 0

    for path in files:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for spec in sorted(set(IMPORT_RE.findall(text))):
            total += 1
            resolved = resolve(spec, path, imports)
            rel = os.path.relpath(path, ROOT)
            if resolved is None:
                misses.append("%s -> %s (not in import map)" % (rel, spec))
            elif not os.path.isfile(resolved):
                misses.append(
                    "%s -> %s (maps to missing %s)"
                    % (rel, spec, os.path.relpath(resolved, ROOT))
                )
            elif not spec.startswith("."):
                used.add(spec)
        used.update(DYNAMIC_IMPORT_RE.findall(text))

    print("%d files scanned, %d import specifiers resolved." % (len(files), total))

    unused = sorted(set(imports) - used)
    if unused:
        print("WARNING: import map entries never imported: %s" % ", ".join(unused))

    for entry, target in sorted(imports.items()):
        if not os.path.isfile(os.path.join(ROOT, target)):
            misses.append("import map %s -> missing file %s" % (entry, target))

    if misses:
        print("\nFAIL: %d unresolved import(s)" % len(misses))
        for miss in misses:
            print("  " + miss)
        return 1

    print("OK: import graph closes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
