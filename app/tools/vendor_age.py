#!/usr/bin/env python3
"""Vendor typage (npm `age-encryption`) and its five noble/scure dependencies.

Port of `crypto-proto/vendor.sh`, with one addition the prototype did not need:
the REWRITE STEP below. Downloads registry tarballs with curl, keeps runtime
`.js` plus each LICENSE, drops `.d.ts`, `.map` and `src/`. No npm, no bundler,
no jsdelivr (its `+esm` build fetches from the CDN at runtime, which breaks the
offline requirement).

Usage: python3 tools/vendor_age.py        (writes vendor/ and merges versions.json)


WHY THIS SCRIPT EXISTS AT ALL (the rewrite step)
------------------------------------------------
An import map applies to the window only. A *dedicated worker* ignores it, and
the unlock step must run in a worker: noble's scrypt is synchronous and typage
calls it synchronously, so unlock blocks the main thread for ~600 ms
(crypto-proto/REPORT.md Q4). So the age family cannot be resolved by the import
map the way the CodeMirror packages are. Instead every bare specifier in the
vendored tree is rewritten, at vendor time, to a relative path. The tree then
loads identically in the window and in a worker, and `index.html` gets no new
import-map entries.


WHY THE VERSIONS ARE PINNED, AND NOT "LATEST"
---------------------------------------------
The vendor tree is FLAT: one specifier resolves to one file, and it cannot
nest. `@noble/post-quantum` 0.5.4 requires `@noble/curves` `~2.0.0` and
`@noble/hashes` `~2.0.0`; typage requires `^2.0.1` for both. npm would resolve
that by installing the newest at the top and a second, nested copy of 2.0.x
under post-quantum. A flat tree must pick the one version that satisfies both
ranges, and 2.0.1 is that version for hashes and for curves. Taking "latest"
(2.4.0 for hashes) 404s nothing and breaks nothing at load time; it breaks
silently at runtime inside ML-KEM. Keep the pins, keep this comment.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from jsscan import mask_comments

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
REGISTRY = "https://registry.npmjs.org"

# package -> (version, tarball path on the registry, output dir under vendor/)
PACKAGES = {
    "age-encryption": ("0.3.1", "age-encryption/-/age-encryption-%s.tgz", "age-encryption"),
    "@noble/hashes": ("2.0.1", "@noble/hashes/-/hashes-%s.tgz", "@noble/hashes"),
    "@noble/curves": ("2.0.1", "@noble/curves/-/curves-%s.tgz", "@noble/curves"),
    "@noble/ciphers": ("2.4.0", "@noble/ciphers/-/ciphers-%s.tgz", "@noble/ciphers"),
    "@noble/post-quantum": ("0.5.4", "@noble/post-quantum/-/post-quantum-%s.tgz", "@noble/post-quantum"),
    "@scure/base": ("2.4.0", "@scure/base/-/base-%s.tgz", "@scure/base"),
}

# `import ... from "x"`, `import "x"`, `export ... from "x"`. The capture groups
# are the statement head, the quote, and the specifier, so a rewrite can put the
# same quote character back.
# \b after import/export and a specifier class without spaces or colons are both
# required: without them, keyword tables inside vendored bundles parse as import
# statements and yield garbage specifiers.
IMPORT_RE = re.compile(
    r"""((?:^|[\s;}])(?:import|export)\b\s*(?:[\w*{},\s$]*?\s*from\s*)?)(["'])((?:@|\.{0,2}/|\w)[^"'\s:]*)\2""",
    re.M,
)

# Dynamic `import("x")`. typage and noble have none today; the scan reports any
# a future version introduces, because they need the same rewrite.
DYNAMIC_IMPORT_RE = re.compile(r"""\bimport\(\s*(["'])((?:@|\.{0,2}/|\w)[^"'\s:]*)\1\s*\)""")


def curl(url, dest):
    p = subprocess.run(
        ["curl", "-sSL", "--fail", "--max-time", "120", url, "-o", dest],
        capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError("curl failed for %s: %s" % (url, p.stderr.decode()[:400]))


def fetch(pkg, tmp):
    """Download and unpack one package, return its unpacked directory."""
    version, url_tpl, _out = PACKAGES[pkg]
    url = "%s/%s" % (REGISTRY, url_tpl % version)
    tar = os.path.join(tmp, os.path.basename(url))
    curl(url, tar)
    unpacked = os.path.join(tmp, "x-" + os.path.basename(url))
    os.makedirs(unpacked, exist_ok=True)
    subprocess.run(
        ["tar", "xzf", tar, "-C", unpacked, "--strip-components=1"], check=True
    )
    return unpacked


def copy_runtime(src, dst):
    """Copy every `*.js` outside `src/`, plus LICENSE. Nothing else."""
    count = 0
    for dirpath, _dirnames, filenames in os.walk(src):
        rel_dir = os.path.relpath(dirpath, src)
        if rel_dir.split(os.sep)[0] == "src":
            continue
        for name in sorted(filenames):
            if not name.endswith(".js"):
                continue
            out_dir = os.path.join(dst, rel_dir) if rel_dir != "." else dst
            os.makedirs(out_dir, exist_ok=True)
            shutil.copyfile(os.path.join(dirpath, name), os.path.join(out_dir, name))
            count += 1
    licence = os.path.join(src, "LICENSE")
    if os.path.isfile(licence):
        os.makedirs(dst, exist_ok=True)
        shutil.copyfile(licence, os.path.join(dst, "LICENSE"))
    return count


def target_of(spec):
    """Absolute path a bare specifier must resolve to, or None if not ours."""
    for pkg, (_v, _u, out) in PACKAGES.items():
        if spec == pkg:
            # A package root (`@scure/base`, `age-encryption`) is its index.js.
            return os.path.join(VENDOR, out, "index.js")
        if spec.startswith(pkg + "/"):
            sub = spec[len(pkg) + 1:]
            # An extensionless subpath (`@noble/hashes/sha2`) names the same
            # file as `sha2.js`; only the real name exists in the tree.
            if not sub.endswith(".js"):
                sub += ".js"
            return os.path.join(VENDOR, out, *sub.split("/"))
    return None


def relative(target, importer):
    rel = os.path.relpath(target, os.path.dirname(importer)).replace(os.sep, "/")
    # A module specifier must start with "./", "../" or "/". A bare "utils.js"
    # would be read as a bare specifier again and go nowhere.
    return rel if rel.startswith(".") else "./" + rel


def vendored_files():
    files = []
    for _pkg, (_v, _u, out) in PACKAGES.items():
        base = os.path.join(VENDOR, *out.split("/"))
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in sorted(filenames):
                if name.endswith(".js"):
                    files.append(os.path.join(dirpath, name))
    return sorted(files)


def rewrite_all():
    """Turn every bare specifier in the tree into a relative path."""
    changed = 0
    rewrites = 0
    for path in vendored_files():
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        # Matches are found in the masked copy but applied to the original, so
        # the quote style, the spacing, and everything inside comments survive.
        masked = mask_comments(text)

        edits = []
        for match in IMPORT_RE.finditer(masked):
            target = target_of(match.group(3))
            if target is not None:
                edits.append((match.start(3), match.end(3), relative(target, path)))
        for match in DYNAMIC_IMPORT_RE.finditer(masked):
            target = target_of(match.group(2))
            if target is not None:
                edits.append((match.start(2), match.end(2), relative(target, path)))

        if not edits:
            continue
        new = text
        for start, end, replacement in sorted(edits, reverse=True):
            new = new[:start] + replacement + new[end:]
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new)
        changed += 1
        rewrites += len(edits)
    return changed, rewrites


def assert_no_bare():
    """Fail loudly if any specifier for the six packages survived the rewrite.

    A survivor is invisible in the window (nothing 404s until the module is
    actually needed) and shows up as a broken worker at unlock time, far from
    here. Assert at vendor time instead.
    """
    misses = []
    dynamic = []
    for path in vendored_files():
        with open(path, encoding="utf-8") as fh:
            text = mask_comments(fh.read())
        rel = os.path.relpath(path, ROOT)
        for _head, _q, spec in IMPORT_RE.findall(text):
            if target_of(spec) is not None:
                misses.append("%s -> %s (bare specifier survived)" % (rel, spec))
            elif not spec.startswith("."):
                misses.append("%s -> %s (unknown bare specifier)" % (rel, spec))
            elif not os.path.isfile(
                os.path.normpath(os.path.join(os.path.dirname(path), spec))
            ):
                misses.append("%s -> %s (missing file)" % (rel, spec))
        for _q, spec in DYNAMIC_IMPORT_RE.findall(text):
            if not spec.startswith("."):
                dynamic.append("%s -> import(%s)" % (rel, spec))

    for entry in dynamic:
        print("dynamic import of a bare specifier: " + entry)
    if misses or dynamic:
        print("\nFAIL: %d unrewritten specifier(s)" % (len(misses) + len(dynamic)))
        for miss in misses:
            print("  " + miss)
        raise SystemExit(1)


def merge_versions():
    path = os.path.join(ROOT, "tools", "versions.json")
    with open(path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    # Merge, never overwrite: this file also carries the CodeMirror pins that
    # tools/vendor.py owns, and neither script may drop the other's entries.
    for pkg, (version, _u, _o) in PACKAGES.items():
        manifest.setdefault("versions", {})[pkg] = version
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")


def main():
    tmp = tempfile.mkdtemp(prefix="vrtti-age-")
    try:
        for pkg, (version, _u, out) in PACKAGES.items():
            unpacked = fetch(pkg, tmp)
            dst = os.path.join(VENDOR, *out.split("/"))
            shutil.rmtree(dst, ignore_errors=True)
            if pkg == "age-encryption":
                # typage ships everything under dist/. Flatten it one level so
                # the tree looks like every other vendored package and the
                # relative paths out of it are one hop shorter.
                os.makedirs(dst, exist_ok=True)
                copied = copy_runtime(os.path.join(unpacked, "dist"), dst)
                shutil.copyfile(
                    os.path.join(unpacked, "LICENSE"), os.path.join(dst, "LICENSE")
                )
            else:
                copied = copy_runtime(unpacked, dst)
            print("%-24s %-8s %2d js files" % (pkg, version, copied))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    changed, rewrites = rewrite_all()
    print("rewrote %d bare specifiers in %d files" % (rewrites, changed))
    assert_no_bare()
    merge_versions()

    files = vendored_files()
    total = sum(os.path.getsize(f) for f in files)
    print("OK: %d JS files, %d bytes, no bare specifiers left." % (len(files), total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
