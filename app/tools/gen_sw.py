#!/usr/bin/env python3
"""Regenerate sw-precache.js: the service worker's file list + cache version.

Run from anywhere; paths are anchored to this file's location. The version is
a content hash over every precached file, so any byte change produces a new
cache name and triggers a service worker update.
"""

import hashlib
import json
from pathlib import Path

POC = Path(__file__).resolve().parent.parent

# Not precached: dev tooling and docs are still served, but the offline app
# does not need them. sw.js and sw-precache.js are handled by the SW lifecycle
# itself and must not be inside their own cache.
EXCLUDE_DIRS = {"tools"}
EXCLUDE_FILES = {"sw.js", "sw-precache.js", "screenshot.png", "VENDOR.md"}


def precache_files():
    files = []
    for path in sorted(POC.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(POC)
        if rel.parts[0] in EXCLUDE_DIRS or rel.name in EXCLUDE_FILES:
            continue
        files.append(rel)
    return files


def main():
    files = precache_files()
    digest = hashlib.sha256()
    for rel in files:
        digest.update(str(rel).encode())
        digest.update((POC / rel).read_bytes())
    version = digest.hexdigest()[:12]

    # "./" first: it is the URL a navigation to the scope root actually uses.
    urls = ["./"] + ["./" + rel.as_posix() for rel in files]
    body = "self.__PRECACHE = " + json.dumps(
        {"version": version, "files": urls}, indent=2
    ) + ";\n"
    (POC / "sw-precache.js").write_text(body)
    print(f"sw-precache.js: {len(urls)} URLs, version {version}")


if __name__ == "__main__":
    main()
