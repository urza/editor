#!/usr/bin/env bash
# One updater manifest for one platform key (architecture.md §18), on
# stdout, in tauri-plugin-updater's single-platform format.
#
#   latest-json.sh <version> <url> <sig-file> [notes]
#
# The shell asks for latest-{{target}}-{{arch}}.json, so desktop.yml runs
# this once per platform key. One file per key, never one merged file: a
# merged manifest has one version, and a platform whose build failed would
# send its shells after their own old file at every check.
set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "usage: $0 <version> <url> <sig-file> [notes]" >&2
  exit 2
fi
version=$1
url=$2
sig=$3
notes=${4:-}

# The plugin parses version as semver and compares it to the running one;
# a stray "v" or a build tag would make every shell think it is behind.
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must be X.Y.Z, got '$version'" >&2
  exit 2
fi
if ! [[ $url =~ ^https?:// ]]; then
  echo "url must be http(s), got '$url'" >&2
  exit 2
fi
if ! [ -s "$sig" ]; then
  echo "signature file missing or empty: $sig" >&2
  exit 2
fi

# pub_date must be RFC 3339 or the plugin rejects the whole manifest.
jq -n \
  --arg version "$version" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg url "$url" \
  --rawfile signature "$sig" \
  --arg notes "$notes" \
  '{
    version: $version,
    pub_date: $pub_date,
    url: $url,
    signature: ($signature | sub("\\s+$"; "")),
    notes: $notes
  }'
