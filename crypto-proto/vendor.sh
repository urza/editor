#!/bin/sh
# Vendor typage and its dependencies from registry.npmjs.org. No npm, no bundler.
# This is the exact recipe that produced vendor/. Re-run it to rebuild the tree.
#
# Version pinning rule, and the reason it is not "just use latest":
# an import map is FLAT. npm would nest a second copy of @noble/curves and
# @noble/hashes under @noble/post-quantum, because post-quantum 0.5.4 wants
# ~2.0.0 while typage wants ^2.0.1. A flat tree cannot do that, so we pin
# curves and hashes to 2.0.1, the one version that satisfies both.
set -eu

AGE_ENCRYPTION=0.3.1
NOBLE_HASHES=2.0.1        # ~2.0.0 (post-quantum) AND ^2.0.1 (typage)
NOBLE_CURVES=2.0.1        # same constraint pair
NOBLE_CIPHERS=2.4.0       # ^2.1.1, no dependants to conflict with
NOBLE_PQ=0.5.4            # ^0.5.3
SCURE_BASE=2.4.0          # ^2.0.0

OUT=${1:-vendor}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

get() { # get <tarball-url> <dest-dir>
  name=$(basename "$1")
  curl -sSL "$1" -o "$TMP/$name"
  mkdir -p "$TMP/x-$name"
  tar xzf "$TMP/$name" -C "$TMP/x-$name" --strip-components=1
  mkdir -p "$2"
  # Ship runtime JS and the licence only. No .d.ts, no source maps, no src/.
  (cd "$TMP/x-$name" && find . -name '*.js' -not -path './src/*') | while read -r f; do
    mkdir -p "$2/$(dirname "$f")"
    cp "$TMP/x-$name/$f" "$2/$f"
  done
  [ -f "$TMP/x-$name/LICENSE" ] && cp "$TMP/x-$name/LICENSE" "$2/LICENSE"
}

R=https://registry.npmjs.org
rm -rf "$OUT"
# typage ships everything under dist/; flatten it so the import map key is short.
get "$R/age-encryption/-/age-encryption-$AGE_ENCRYPTION.tgz" "$TMP/typage"
mkdir -p "$OUT/age-encryption"
cp "$TMP/typage"/dist/*.js "$OUT/age-encryption/"
cp "$TMP/typage/LICENSE" "$OUT/age-encryption/LICENSE"

get "$R/@noble/hashes/-/hashes-$NOBLE_HASHES.tgz"              "$OUT/noble-hashes"
get "$R/@noble/curves/-/curves-$NOBLE_CURVES.tgz"              "$OUT/noble-curves"
get "$R/@noble/ciphers/-/ciphers-$NOBLE_CIPHERS.tgz"           "$OUT/noble-ciphers"
get "$R/@noble/post-quantum/-/post-quantum-$NOBLE_PQ.tgz"      "$OUT/noble-post-quantum"
get "$R/@scure/base/-/base-$SCURE_BASE.tgz"                    "$OUT/scure-base"

echo "vendored $(find "$OUT" -name '*.js' | wc -l) JS files, $(du -sh "$OUT" | cut -f1)"
