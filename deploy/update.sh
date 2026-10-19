#!/usr/bin/env bash
set -euo pipefail

cd /opt/hq-jr/deploy

override=""
cleanup() {
  if [ -n "$override" ]; then
    rm -f "$override"
  fi
}
trap cleanup EXIT

health() {
  docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/livez',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_healthy() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health; then
      return 0
    fi
    local remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      break
    fi
    if [ "$remaining" -gt 5 ]; then
      remaining=5
    fi
    sleep "$remaining"
  done
  return 1
}

deploy_image() {
  local ref="$1"
  override=$(mktemp)
  cat > "$override" <<YAML
services:
  app:
    image: ${ref}
YAML
  docker compose -f compose.yaml -f "$override" up -d --force-recreate --no-deps app
  local result=1
  if wait_healthy; then
    result=0
  fi
  rm -f "$override"
  override=""
  return "$result"
}

# Respect a pinned image in compose instead of assuming :latest.
image=$(docker compose config --images | head -n1)
running=$(docker inspect --format '{{.Image}}' hq-jr 2>/dev/null || true)
failed_marker=/opt/hq-jr/deploy/.last-failed-image

docker compose pull --quiet app
latest=$(docker image inspect --format '{{.Id}}' "$image")

if [ -f "$failed_marker" ] && [ "$(cat "$failed_marker")" = "$latest" ]; then
  echo "image ${latest:7:12} is marked as failed; not deploying it"

  if [ "$running" = "$latest" ]; then
    if docker image inspect hq-jr:rollback >/dev/null 2>&1; then
      echo "restoring the previous rollback image"
      if deploy_image hq-jr:rollback; then
        echo "rollback image is healthy; update failed" >&2
        exit 1
      fi
      echo "rollback image failed its health check" >&2
      exit 1
    fi

    echo "the marked image is currently running; attempting restart"
    docker compose restart app
    if wait_healthy; then
      rm -f "$failed_marker"
      echo "hq-jr healthy after restart"
      exit 0
    fi
    echo "the marked image is still unhealthy" >&2
    exit 1
  fi

  if health; then
    echo "current rollback container is healthy (${running:7:12})"
    exit 0
  fi

  echo "current rollback container is unhealthy; restarting" >&2
  docker compose restart app
  if wait_healthy; then
    echo "rollback container healthy after restart"
    exit 0
  fi

  echo "rollback container did not recover" >&2
  exit 1
fi

if [ -n "$running" ] && [ "$running" = "$latest" ]; then
  if health; then
    rm -f "$failed_marker"
    echo "hq-jr is current and healthy (${latest:7:12})"
    exit 0
  fi

  echo "hq-jr is current but unhealthy; restarting"
  docker compose restart app
  if wait_healthy; then
    rm -f "$failed_marker"
    echo "hq-jr healthy after restart"
    exit 0
  fi

  echo "restart did not recover hq-jr" >&2
  exit 1
fi

echo "updating hq-jr from ${running:7:12} to ${latest:7:12}"
docker compose up -d --no-deps app

if wait_healthy; then
  rm -f "$failed_marker"
  echo "hq-jr healthy on ${latest:7:12}"
  if [ -n "$running" ]; then
    docker image rm "$running" >/dev/null 2>&1 || true
  fi
  exit 0
fi

echo "hq-jr failed its health check after updating to ${latest:7:12}" >&2
printf '%s\n' "$latest" > "$failed_marker"

if [ -n "$running" ]; then
  echo "rolling back to ${running:7:12}" >&2
  docker tag "$running" hq-jr:rollback
  if deploy_image hq-jr:rollback; then
    echo "rollback healthy on ${running:7:12}" >&2
  else
    echo "rollback failed its health check" >&2
  fi
fi

exit 1
