#!/usr/bin/env bash
# Pull deploy for a Lyren Plan server installed as in docs/ubuntu-server.md: when the repository's
# latest release is a new CI build, install it the way §12 upgrades by hand. Runs as root from
# lyren-pull-deploy.timer. See README.md in this folder.
#
# Why pull: the server needs no inbound access and GitHub holds no key to it. What it trusts is a
# release of REPO whose tag is build-<n> and whose author is github-actions[bot], i.e. one the deploy
# workflow published after the tests passed on main.
#
# Steps for a new tag: download the Node.js archive and its .sha256 file, check it, extract it into
# its own folder (<OPT>/lyren-<tag>), back up with the running version (lyren-plan-backup), stop,
# point `current` at the new folder, start, and wait for /api/health. If the health check fails it
# stops, points `current` back and starts the previous version, and remembers the tag as failed so
# it isn't retried every run. (Rolling back is safe only while the new build's migrations are
# compatible with the old one; a build whose migration isn't must be deployed by hand, §12.)
#
# Config, /etc/lyren-deploy.env:
#   REPO=<owner>/<repo>                          required
#   OPT=/opt/lyren-plan                          default
#   HEALTH_URL=http://127.0.0.1:8080/api/health  default
#   KEEP=5                                       pull-deployed folders to keep (current and previous always kept)

set -euo pipefail

CONFIG=${LYREN_DEPLOY_CONFIG:-/etc/lyren-deploy.env}
# shellcheck disable=SC1090
[[ -r $CONFIG ]] && . "$CONFIG"
: "${REPO:?REPO is not set in $CONFIG}"
OPT=${OPT:-/opt/lyren-plan}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8080/api/health}
KEEP=${KEEP:-5}
STATE=${STATE:-/var/lib/lyren-pull-deploy}
mkdir -p "$STATE"

log() { echo "lyren-pull-deploy: $*"; }

release=$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/releases/latest") || { log "could not read the latest release of $REPO"; exit 1; }
tag=$(jq -r '.tag_name // empty' <<<"$release")
author=$(jq -r '.author.login // empty' <<<"$release")

if [[ ! $tag =~ ^build-[0-9]+$ ]]; then
  log "latest release '$tag' is not a CI build; nothing to do"
  exit 0
fi
[[ $(cat "$STATE/deployed-tag" 2>/dev/null) == "$tag" ]] && exit 0
if [[ $(cat "$STATE/failed-tag" 2>/dev/null) == "$tag" ]]; then
  log "$tag failed before and was rolled back; waiting for a newer build"
  exit 0
fi
if [[ $author != 'github-actions[bot]' ]]; then
  log "refusing $tag: published by '$author', not by the deploy workflow"
  echo "$tag" >"$STATE/failed-tag"
  exit 1
fi

archive_url=$(jq -r '.assets[] | select(.name | test("^lyren-plan-.*-node\\.tar\\.gz$")) | .browser_download_url' <<<"$release")
sha_url=$(jq -r '.assets[] | select(.name | test("^lyren-plan-.*-node\\.tar\\.gz\\.sha256$")) | .browser_download_url' <<<"$release")
if [[ -z $archive_url || -z $sha_url || $archive_url == *$'\n'* ]]; then
  log "refusing $tag: it doesn't have exactly one Node.js archive and its .sha256 file"
  echo "$tag" >"$STATE/failed-tag"
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO --max-time 300 "$archive_url"
curl -fsSLO --max-time 60 "$sha_url"
sha256sum -c --quiet ./*.sha256 || { log "refusing $tag: the archive doesn't match its .sha256 file"; echo "$tag" >"$STATE/failed-tag"; exit 1; }

name=lyren-$tag
target=$OPT/$name
rm -rf "$target"
mkdir -p "$target"
tar -xzf ./lyren-plan-*-node.tar.gz -C "$target" --strip-components=1 --no-same-owner
[[ -f $target/server.mjs && -f $target/web/index.html ]] || { log "refusing $tag: no server.mjs or web/index.html in the archive"; rm -rf "$target"; echo "$tag" >"$STATE/failed-tag"; exit 1; }

previous=$(readlink "$OPT/current")
log "deploying $tag (was $previous)"
systemctl start lyren-plan-backup
systemctl stop lyren-plan
ln -sfn "$name" "$OPT/current"
systemctl start lyren-plan

healthy=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then healthy=true; break; fi
  sleep 1
done

if ! $healthy; then
  log "$tag did not answer $HEALTH_URL within 60 s: rolling back to $previous"
  journalctl -u lyren-plan -n 30 --no-pager || true
  systemctl stop lyren-plan
  ln -sfn "$previous" "$OPT/current"
  systemctl start lyren-plan
  echo "$tag" >"$STATE/failed-tag"
  exit 1
fi

echo "$tag" >"$STATE/deployed-tag"
echo "$previous" >"$STATE/previous"
log "$tag is live"

# Tidy: keep the newest KEEP pull-deployed folders, never the one running or the one before it.
mapfile -t builds < <(find "$OPT" -mindepth 1 -maxdepth 1 -type d -name 'lyren-build-*' -printf '%f\n' | sort -t- -k3 -n)
excess=$(( ${#builds[@]} - KEEP ))
for ((i = 0; i < excess; i++)); do
  b=${builds[$i]}
  [[ $b == "$name" || $b == "$previous" ]] && continue
  rm -rf "${OPT:?}/$b"
done
