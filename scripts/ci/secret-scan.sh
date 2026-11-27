#!/usr/bin/env bash
# Secret scan, no model. Usage:
#   secret-scan.sh diff <base-commit-or-tree>   scan only lines added since base
#   secret-scan.sh dir  <path>                  scan every text file under path (the deploy payload)
# Patterns are Gary's deploy-rule list. Each is written with a [x] bracket so this file never matches itself.
# A hit fails the run. Matching lines are never printed (a log is a place a secret can leak): only path:line.
# Allowlist: .ci/secret-scan-allow.tsv, one "path-glob<TAB>fixed substring" per row, reviewed by Gary. A row
# exempts only the occurrences of its substring: they are cut out of the line and the rest is scanned again,
# so a row for one phrase on a long minified line doesn't blind the scan to the rest of that line.
# The allowlist file itself is not scanned (its rows quote the phrases they exempt); it is read from the base
# branch on PRs and every change to it is reviewed.
set -euo pipefail
mode=${1:?usage: secret-scan.sh diff <base> | dir <path>}; arg=${2:?usage}
allow=${SECRET_SCAN_ALLOW:-.ci/secret-scan-allow.tsv}
ALLOW_REPO_PATH=.ci/secret-scan-allow.tsv
# lyren has a password login, so the bare word is everywhere (2,520 of 2,644 whole-repo hits, 2026-11-26).
# Here only a password ASSIGNED A LITERAL of 8+ characters counts: password = "…", password: '…', "password": "…".
# Gary chose this for lyren only (GEN-233 option 1, 2026-11-27); every other repo keeps the bare word.
PAT_I=('[c]lient_secret' '[a]pi[_-]?key' '[r]efresh_token' '[t]oken='
       "[p]assword[\"']?[[:space:]]*[:=][[:space:]]*[\"'\`][^\"'\`[:space:]]{8,}")   # case-insensitive
PAT_S=('[G]OCSPX-' 'BEGI[N] .*PRIVATE KEY' '[A]KIA' '[B]earer ')                       # case-sensitive
ai=(); for p in "${PAT_I[@]}"; do ai+=(-e "$p"); done
as=(); for p in "${PAT_S[@]}"; do as+=(-e "$p"); done
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
P=$work/paths L=$work/lines N=$work/nums; : >"$P"; : >"$L"; : >"$N"

MEDIA='\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?)$'   # the only files that may be skipped, and only if truly binary
has_nul() { [ "$(head -c 8000 "$1" | LC_ALL=C tr -d '\000' | wc -c)" -ne "$(head -c 8000 "$1" | wc -c)" ]; }
add_file() { # add_file <label> <file>: every line of a file, NULs read as spaces so nothing hides behind one
  case $1 in *$'\n'*) echo "secret-scan: a path contains a newline" >&2; exit 2 ;; esac
  if printf '%s\n' "$1" | grep -qiE "$MEDIA" && has_nul "$2"; then return 0; fi
  # The name goes through ENVIRON: awk -v would turn a literal backslash-n in it into a newline.
  LC_ALL=C tr '\000' ' ' <"$2" | F="$1" LC_ALL=C awk -v P="$P" -v L="$L" -v N="$N" \
    '{ print ENVIRON["F"] >> P; print $0 >> L; print NR >> N }'
}

case $mode in
  diff)
    base=$(git merge-base "$arg" HEAD 2>/dev/null || echo "$arg")
    # --no-textconv/--no-ext-diff: no repo-configured filter decides what the scanner sees.
    # R and C: a renamed or copied file's added lines are scanned too.
    git -c core.quotePath=false diff -U0 --no-color --no-textconv --no-ext-diff --diff-filter=AMRC \
      "$base" HEAD >"$work/patch"
    # A "+++ b/" line is a file header only before the first hunk of a file; inside a hunk it's content.
    LC_ALL=C awk -v P="$P" -v L="$L" -v N="$N" '
      /^diff --git /                    { inh = 0; f = ""; next }
      !inh && /^\+\+\+ /                { f = ($0 ~ /^\+\+\+ b\//) ? substr($0, 7) : ""; next }
      /^@@ /                            { inh = 1; match($0, /\+[0-9]+/); ln = substr($0, RSTART + 1, RLENGTH - 1) + 0; next }
      inh && /^\+/                      { print f >> P; print substr($0, 2) >> L; print ln >> N; ln++ }' "$work/patch"
    # Files git reports as binary (a NUL byte, or a .gitattributes mark a PR could add) print no lines, so each
    # is read whole from HEAD. Only real media files with a NUL are skipped; the payload check covers those.
    # The list comes from NUL-delimited --numstat ("-<TAB>-" marks binary), never from git's human-readable
    # notice, so any filename survives. A rename record is "-<TAB>-<TAB>" then the old and new paths.
    git -c core.quotePath=false diff --numstat -z --no-textconv --no-ext-diff --diff-filter=AMRC "$base" HEAD >"$work/numstat"
    while IFS= read -r -d '' rec; do
      path=${rec#*$'\t'*$'\t'}
      if [ -z "$path" ]; then IFS= read -r -d '' _old; IFS= read -r -d '' path; fi
      case $rec in -$'\t'-$'\t'*) ;; *) continue ;; esac
      git cat-file blob "HEAD:$path" >"$work/blob"
      add_file "$path" "$work/blob"
    done <"$work/numstat"
    ;;
  dir)
    [ -d "$arg" ] || { echo "no such directory: $arg" >&2; exit 2; }
    find "$arg" -type f -not -path '*/.git/*' -print0 >"$work/files"   # a traversal error stops the scan (set -e)
    # One file at a time, so no filename (colons and all) is ever parsed out of grep output.
    while IFS= read -r -d '' f; do
      [ -r "$f" ] || { echo "secret-scan: can't read a payload file" >&2; exit 2; }
      add_file "$f" "$f"
    done <"$work/files" ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac

hits() { # hits <file>: line numbers (1-based) that match any pattern; grep's "no match" is not an error
  local rc=0
  { grep -inE "${ai[@]}" "$1" || rc=$?; [ "$rc" -le 1 ] || exit 2; rc=0
    grep -nE "${as[@]}" "$1" || rc=$?; [ "$rc" -le 1 ] || exit 2; } | cut -d: -f1 | sort -un
}
matches() { # matches <text>: does the text still contain a pattern?
  printf '%s\n' "$1" | grep -qiE "${ai[@]}" || printf '%s\n' "$1" | grep -qE "${as[@]}"
}

scanned=$(wc -l <"$L")
hits "$L" >"$work/hit-lines"

fail=0
while read -r n; do
  [ -n "$n" ] || continue
  path=$(sed -n "${n}p" "$P"); line=$(sed -n "${n}p" "$L"); num=$(sed -n "${n}p" "$N")
  [ "$path" = "$ALLOW_REPO_PATH" ] && continue
  rest=$line
  if [ -f "$allow" ]; then
    while IFS=$'\t' read -r glob sub; do
      case $glob in ''|'#'*) continue ;; esac
      [ -n "$sub" ] || continue
      # shellcheck disable=SC2254
      # Cut every literal occurrence (awk index(), not bash ${//}: that is near-quadratic on a one-line bundle).
      case $path in $glob) rest=$(printf '%s' "$rest" | S="$sub" LC_ALL=C awk '{ s = ENVIRON["S"]
          out = ""; while ((i = index($0, s)) > 0) { out = out substr($0, 1, i - 1); $0 = substr($0, i + length(s)) }
          printf "%s", out $0 }') ;; esac
    done <"$allow"
  fi
  if matches "$rest"; then echo "::error file=$path,line=$num::secret-shaped text (content not printed)"; fail=1; fi
done <"$work/hit-lines"

echo "secret-scan $mode: $scanned lines scanned"
[ "$fail" = 0 ] || { echo "FAILED: any hit fails. Remove it, or if it is a reviewed false positive add a row to $allow (takes effect after merge)." >&2; exit 1; }
