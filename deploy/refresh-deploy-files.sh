#!/usr/bin/env bash
# Refresh the deploy files in /opt/hq-jr/deploy from a released image.
#
# Usage: refresh-deploy-files.sh [image]
#
# Without an argument the image is the one compose.yaml runs, so a pinned
# version stays pinned. The image is pulled first, so a stale local copy is
# never used. compose.yaml is host configuration and is never overwritten.
# The copy from the image is written next to it as compose.yaml.release.
set -euo pipefail

deploy_dir="${HQ_JR_DEPLOY_DIR:-/opt/hq-jr/deploy}"
cd "$deploy_dir"

if [ "$#" -gt 0 ]; then
  image="$1"
else
  image="$(docker compose config --images | head -n1)"
fi
if [ -z "$image" ]; then
  echo "could not read the image reference from compose.yaml" >&2
  exit 1
fi

docker pull --quiet "$image" >/dev/null

container=""
staging="$(mktemp -d "$deploy_dir/.refresh.XXXXXX")"
cleanup() {
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  rm -rf "$staging"
}
trap cleanup EXIT

container="$(docker create "$image")"
docker cp "$container:/app/deploy/." "$staging/"

# The staging directory is on the same filesystem, so each mv is an atomic
# rename and a running copy of this script or update.sh is never truncated.
# The default glob skips names that start with a dot, and an empty directory
# expands to the literal pattern. Match hidden files, and expand nothing
# when the directory is empty.
shopt -s dotglob nullglob
for file in "$staging"/*; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  if [ "$name" = compose.yaml ]; then
    mv -f "$file" "$deploy_dir/compose.yaml.release"
  else
    mv -f "$file" "$deploy_dir/$name"
  fi
done

echo "deploy files refreshed from $image"
if ! cmp -s compose.yaml compose.yaml.release; then
  echo "compose.yaml differs from the release copy; review compose.yaml.release"
fi
