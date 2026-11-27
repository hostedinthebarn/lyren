#!/usr/bin/env bash
# Deploy file-type allowlist. Usage: check-payload.sh <payload-dir>
# Allowlist, never denylist: a file passes only if its extension is listed. The deny regex only gives a clearer message.
# ALLOWED_EXT must be copied from the repo's own check-publish list. Do not widen it here.
set -euo pipefail
dir=${1:?usage: check-payload.sh <payload-dir>}
[ -d "$dir" ] || { echo "no such directory: $dir (did the build run?)" >&2; exit 2; }
# This repo's list: what dist/web holds (the workflow sets the same value).
ALLOWED_EXT=${ALLOWED_EXT:-'html|css|js|map|svg|png|webmanifest|txt'}
ALLOWED_NAMES=${ALLOWED_NAMES:-'_headers|_redirects'}
DENY='(^|/)(CLAUDE\.md|memory)(/|$)|\.(md|py|sh|env|pem|key|csr|rtf)$'
# List first, so a traversal error fails the check instead of vanishing inside a process substitution.
list=$(mktemp); trap 'rm -f "$list"' EXIT
find "$dir" -mindepth 1 \( -type f -o -type l \) -print0 >"$list" || { echo "listing $dir failed" >&2; exit 2; }
fail=0; count=0
while IFS= read -r -d '' f; do
  count=$((count+1)); rel=${f#"$dir"/}; base=${rel##*/}
  ext=$(printf '%s' "${base##*.}" | tr 'A-Z' 'a-z')
  why=''
  if [ -L "$f" ]; then why='symlink'
  elif [[ $rel =~ $DENY ]]; then why='forbidden type or path'
  elif [[ /$rel == */.* && $rel != .well-known/* && /$rel != */.well-known/* ]]; then why='dotfile or dot folder'
  elif [[ $base == *.* && $ext =~ ^($ALLOWED_EXT)$ ]]; then :
  elif [[ $base =~ ^($ALLOWED_NAMES)$ ]]; then :
  else why='not on the web-asset allowlist'; fi
  if [ -n "$why" ]; then echo "::error file=$rel::$why"; fail=1; fi
done <"$list"
# An empty payload would pass vacuously: that means the build or the path is wrong.
[ "$count" -gt 0 ] || { echo "payload $dir is empty: refusing to pass" >&2; exit 1; }
echo "check-payload: $count files in $dir"
[ "$fail" = 0 ] || { echo "FAILED: payload holds non-web files" >&2; exit 1; }
