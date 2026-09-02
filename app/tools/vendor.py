#!/usr/bin/env python3
"""Vendor CodeMirror packages as prebuilt ESM files (Route B).

Downloads with curl from cdn.jsdelivr.net, one file per package, and follows
bare import specifiers until the graph is closed. No npm, no bundler.

Usage: python3 tools/vendor.py            (writes vendor/ and versions.json)
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")

START = [
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/commands",
    "@codemirror/search",
    "@codemirror/lang-markdown",
    "@codemirror/lang-javascript",
]

# Bare specifiers only: no relative paths, no absolute URLs.
# The specifier class forbids spaces and colons on purpose. Without that,
# @lezer/javascript's keyword table entry `"import export from": tags.…`
# parses as an export-from statement and yields a garbage specifier.
IMPORT_RE = re.compile(
    r"""(?:^|[\s;}])(?:import|export)\b\s*(?:[\w*{},\s$]*?\s*from\s*)?["'](@?[\w][\w./@-]*)["']""",
    re.M,
)


def curl(url):
    p = subprocess.run(
        ["curl", "-sSL", "--fail", "--max-time", "60", url],
        capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError("curl failed for %s: %s" % (url, p.stderr.decode()[:400]))
    return p.stdout


def latest_version(pkg):
    meta = json.loads(curl("https://registry.npmjs.org/%s/latest" % pkg))
    return meta["version"]


def esm_entry(pkg, version):
    """Return the package-relative path of the ESM entry.

    The plan assumes dist/index.js. Verify against package.json exports/module
    and use whatever the package really declares.
    """
    meta = json.loads(
        curl("https://cdn.jsdelivr.net/npm/%s@%s/package.json" % (pkg, version))
    )
    exports = meta.get("exports")
    if isinstance(exports, dict):
        root = exports.get(".", exports)
        if isinstance(root, str):
            return root.lstrip("./")
        if isinstance(root, dict):
            for key in ("import", "module", "default"):
                val = root.get(key)
                if isinstance(val, dict):
                    val = val.get("default") or val.get("import")
                if isinstance(val, str):
                    return val.lstrip("./")
    for key in ("module", "jsnext:main", "main"):
        if isinstance(meta.get(key), str):
            return meta[key].lstrip("./")
    return "dist/index.js"


def main():
    versions = {}
    entries = {}
    queue = list(START)
    seen = set()

    while queue:
        pkg = queue.pop(0)
        if pkg in seen:
            continue
        seen.add(pkg)

        version = latest_version(pkg)
        entry = esm_entry(pkg, version)
        url = "https://cdn.jsdelivr.net/npm/%s@%s/%s" % (pkg, version, entry)
        body = curl(url)

        out_dir = os.path.join(VENDOR, *pkg.split("/"))
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "index.js"), "wb") as fh:
            fh.write(body)

        versions[pkg] = version
        entries[pkg] = entry
        deps = sorted(set(IMPORT_RE.findall(body.decode("utf-8"))))
        print("%-34s %-10s %-16s deps: %s" % (pkg, version, entry, ", ".join(deps) or "-"))
        for dep in deps:
            if dep not in seen:
                queue.append(dep)

    # Merge into the existing manifest instead of replacing it. tools/
    # vendor_age.py pins the age family in the same file, and a plain
    # overwrite here would drop those pins without a word.
    path = os.path.join(ROOT, "tools", "versions.json")
    manifest = {"versions": {}, "entries": {}}
    if os.path.isfile(path):
        with open(path) as fh:
            manifest = json.load(fh)
    manifest.setdefault("versions", {}).update(versions)
    manifest.setdefault("entries", {}).update(entries)
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
    print("\n%d packages vendored." % len(versions))


if __name__ == "__main__":
    sys.exit(main())
