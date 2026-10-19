#!/usr/bin/env bash
set -euo pipefail

cd /opt/hq-jr/deploy

health() {
  docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/livez',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_healthy() {
  for _ in $(seq 1 12); do
    if health; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# Respect a pinned image in compose instead of assuming :latest.
image=$(docker compose config --images | head -n1)
running=$(docker inspect --format '{{.Image}}' hq-jr 2>/dev/null || true)
previous_ref=$(docker inspect --format '{{.Config.Image}}' hq-jr 2>/dev/null || true)
failed_marker=/opt/hq-jr/deploy/.last-failed-image

docker compose pull --quiet app
latest=$(docker image inspect --format '{{.Id}}' "$image")

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

if [ -f "$failed_marker" ] && [ "$(cat "$failed_marker")" = "$latest" ]; then
  echo "skipping image ${latest:7:12}; it previously failed its health check, waiting for a new digest"
  exit 0
fi

echo "updating hq-jr from ${running:7:12} to ${latest:7:12}"
docker compose up -d --no-deps app

if wait_healthy; then
  rm -f "$failed_marker"
  echo "hq-jr healthy on ${latest:7:12}"
  docker image prune -f >/dev/null
  exit 0
fi

echo "hq-jr failed its health check after updating to ${latest:7:12}" >&2
printf '%s\n' "$latest" > "$failed_marker"

if [ -n "$running" ]; then
  echo "rolling back to ${running:7:12} (${previous_ref:-previous image})" >&2
  docker tag "$running" "$image"
  docker compose up -d --force-recreate --no-deps app
  if wait_healthy; then
    echo "rollback healthy on ${running:7:12}" >&2
  else
    echo "rollback also failed its health check" >&2
  fi
fi

exit 1
